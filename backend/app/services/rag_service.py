from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import AISuggestion, Conversation, KnowledgeChunk, Message
from app.services.embedding_service import get_embedding_provider
from app.services.llm_service import get_llm_provider


def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数:中文按字符数,英文按字符数/4 混合近似。
    这里用字符数作为保守上界,避免引入 tokenizer 依赖。
    """
    return len(text or "")


def _resolve_budget(context_budget: int | None) -> int:
    if context_budget is None or context_budget <= 0:
        return settings.default_context_budget
    return min(context_budget, settings.max_context_budget)


def build_prompt(messages: list[Message], chunks: list[KnowledgeChunk]) -> str:
    context = "\n".join(f"{m.sender_type}({m.sender_name or 'unknown'}): {m.content}" for m in messages)
    knowledge = "\n\n".join(f"[知识片段 {i + 1}]\n{chunk.content}" for i, chunk in enumerate(chunks))
    return (
        "请基于企业知识库和最近对话，生成一段客服可复制的回复建议。"
        "不要声称已经执行了尚未完成的操作，不要自动代替客服发送。\n\n"
        f"最近对话：\n{context}\n\n相关知识：\n{knowledge or '暂无命中知识片段'}"
    )


def retrieve_chunks(db: Session, organization_id: int, query: str, limit: int = 5) -> list[KnowledgeChunk]:
    embedding = get_embedding_provider().embed(query)
    stmt = (
        select(KnowledgeChunk)
        .where(KnowledgeChunk.organization_id == organization_id)
        .order_by(KnowledgeChunk.embedding.cosine_distance(embedding))
        .limit(limit)
    )
    return list(db.scalars(stmt))


def trim_to_budget(
    messages: list[Message],
    chunks: list[KnowledgeChunk],
    budget: int,
) -> tuple[list[Message], list[KnowledgeChunk]]:
    """按 token 预算裁剪上下文。优先保留最近的对话消息,知识片段按相似度顺序填充剩余预算。
    预留固定开销给 system prompt 和输出,实际可用预算 = budget - reserved。
    """
    reserved = 2048
    available = max(budget - reserved, 1024)

    # 先按预算从最新消息往前保留对话。
    kept_messages: list[Message] = []
    used = 0
    for message in reversed(messages):
        line = f"{message.sender_type}({message.sender_name or 'unknown'}): {message.content}"
        cost = _estimate_tokens(line) + 1
        if used + cost > available and kept_messages:
            break
        kept_messages.insert(0, message)
        used += cost
        if used >= available:
            break

    # 剩余预算分给知识片段,按现有顺序(相似度从高到低)填充。
    remaining = available - used
    kept_chunks: list[KnowledgeChunk] = []
    for chunk in chunks:
        cost = _estimate_tokens(chunk.content) + 16
        if cost > remaining and kept_chunks:
            break
        kept_chunks.append(chunk)
        remaining -= cost
        if remaining <= 0:
            break

    return kept_messages, kept_chunks


def build_context_preview(
    db: Session,
    conversation_id: int,
    context_budget: int | None = None,
) -> dict:
    """构建上下文预览:返回预算内实际会发给 LLM 的消息、知识片段、统计和拼好的 prompt。
    供预览接口使用,不触发 LLM 调用,不写库。
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise ValueError("Conversation not found")

    # 真实消息总数：conversation 里实际存储的全部消息数，用于预览展示，
    # 不受 recent_message_limit 截断影响。
    total_messages = db.scalar(
        select(func.count(Message.id)).where(Message.conversation_id == conversation_id)
    ) or 0

    # 进入上下文的最近 N 条消息（recent_message_limit 控制窗口大小）。
    recent_messages = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(settings.recent_message_limit)
        )
    )
    recent_messages.reverse()

    trigger = recent_messages[-1] if recent_messages else None
    chunks: list[KnowledgeChunk] = []
    chunk_error: str | None = None
    if trigger:
        try:
            chunks = retrieve_chunks(db, conversation.organization_id, trigger.content)
        except Exception as exc:
            # 预览不依赖 embedding 成功:检索失败时降级为空片段,把错误信息带给前端。
            chunks = []
            chunk_error = f"{type(exc).__name__}: {exc}"

    budget = _resolve_budget(context_budget)
    kept_messages, kept_chunks = trim_to_budget(recent_messages, chunks, budget)
    prompt = build_prompt(kept_messages, kept_chunks)
    used_tokens = _estimate_tokens(prompt)

    return {
        "conversation_id": conversation_id,
        "budget": budget,
        "used_tokens": used_tokens,
        "total_messages": total_messages,
        "kept_messages": len(kept_messages),
        "total_chunks": len(chunks),
        "kept_chunks": len(kept_chunks),
        "messages": kept_messages,
        "chunks": kept_chunks,
        "prompt": prompt,
        "chunk_error": chunk_error,
    }


def generate_suggestion(
    db: Session,
    conversation_id: int,
    trigger_message_id: int,
    context_budget: int | None = None,
) -> AISuggestion:
    conversation = db.get(Conversation, conversation_id)
    trigger = db.get(Message, trigger_message_id)
    if conversation is None or trigger is None:
        raise ValueError("Conversation or trigger message not found")

    recent_messages = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(settings.recent_message_limit)
        )
    )
    recent_messages.reverse()
    chunks = retrieve_chunks(db, conversation.organization_id, trigger.content)
    budget = _resolve_budget(context_budget)
    kept_messages, kept_chunks = trim_to_budget(recent_messages, chunks, budget)
    prompt = build_prompt(kept_messages, kept_chunks)
    llm = get_llm_provider()
    content = llm.generate(prompt)
    suggestion = AISuggestion(
        conversation_id=conversation_id,
        trigger_message_id=trigger_message_id,
        content=content,
        model=llm.model_name,
        status="ready",
        raw_payload={
            "chunk_ids": [chunk.id for chunk in kept_chunks],
            "context_budget": budget,
            "used_messages": len(kept_messages),
            "used_chunks": len(kept_chunks),
        },
    )
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion
