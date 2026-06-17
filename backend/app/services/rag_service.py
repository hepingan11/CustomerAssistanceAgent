from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import AISuggestion, Conversation, KnowledgeChunk, Message
from app.services.embedding_service import get_embedding_provider
from app.services.llm_service import get_llm_provider


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


def generate_suggestion(db: Session, conversation_id: int, trigger_message_id: int) -> AISuggestion:
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
    prompt = build_prompt(recent_messages, chunks)
    llm = get_llm_provider()
    content = llm.generate(prompt)
    suggestion = AISuggestion(
        conversation_id=conversation_id,
        trigger_message_id=trigger_message_id,
        content=content,
        model=llm.model_name,
        status="ready",
        raw_payload={"chunk_ids": [chunk.id for chunk in chunks]},
    )
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion
