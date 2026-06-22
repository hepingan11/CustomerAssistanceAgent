from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_organization
from app.core.database import get_db
from app.models import AISuggestion, Conversation, KnowledgeDocument, Organization
from app.schemas.api import (
    ConversationCreate,
    ConversationRead,
    ContextPreviewResponse,
    KnowledgeDocumentRead,
    MessageCreate,
    MessageRead,
    ReindexResponse,
    SelectorReviewRequest,
    SelectorReviewResponse,
    SuggestionRead,
)
from app.services.knowledge_service import create_document, list_documents
from app.services.message_service import create_message, get_or_create_conversation
from app.services.rag_service import build_context_preview
from app.services.selector_review_service import review_selectors
from app.workers.tasks import generate_ai_suggestion, process_knowledge_document

router = APIRouter()


@router.post("/conversations", response_model=ConversationRead)
def create_or_get_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> Conversation:
    return get_or_create_conversation(db, organization, **payload.model_dump())


@router.post("/messages", response_model=MessageRead)
def receive_message(
    payload: MessageCreate,
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> MessageRead:
    conversation = db.get(Conversation, payload.conversation_id)
    if conversation is None or conversation.organization_id != organization.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    message, duplicate = create_message(db, **payload.model_dump(exclude={"context_budget"}))
    if not duplicate and payload.sender_type in {"customer", "unknown"}:
        generate_ai_suggestion.delay(
            payload.conversation_id,
            message.id,
            payload.context_budget,
        )
    return MessageRead.model_validate(message).model_copy(update={"duplicate": duplicate})


@router.get("/conversations/{conversation_id}/suggestion", response_model=SuggestionRead)
def get_latest_suggestion(
    conversation_id: int,
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> SuggestionRead:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.organization_id != organization.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    suggestion = db.scalar(
        select(AISuggestion)
        .where(AISuggestion.conversation_id == conversation_id)
        .order_by(AISuggestion.created_at.desc())
    )
    if suggestion is None:
        return SuggestionRead(conversation_id=conversation_id, status="pending")
    return SuggestionRead(
        id=suggestion.id,
        conversation_id=suggestion.conversation_id,
        content=suggestion.content,
        status=suggestion.status,
        created_at=suggestion.created_at,
    )


@router.get("/conversations/{conversation_id}/context-preview", response_model=ContextPreviewResponse)
def context_preview(
    conversation_id: int,
    budget: int | None = None,
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> ContextPreviewResponse:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.organization_id != organization.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    try:
        data = build_context_preview(db, conversation_id, budget)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ContextPreviewResponse(
        conversation_id=data["conversation_id"],
        budget=data["budget"],
        used_tokens=data["used_tokens"],
        total_messages=data["total_messages"],
        kept_messages=data["kept_messages"],
        total_chunks=data["total_chunks"],
        kept_chunks=data["kept_chunks"],
        messages=[
            {
                "id": m.id,
                "sender_type": m.sender_type,
                "sender_name": m.sender_name,
                "content": m.content,
                "created_at": m.created_at,
            }
            for m in data["messages"]
        ],
        chunks=[
            {"id": c.id, "content": c.content, "score": None}
            for c in data["chunks"]
        ],
        prompt=data["prompt"],
        chunk_error=data.get("chunk_error"),
    )


@router.post("/knowledge/documents", response_model=KnowledgeDocumentRead)
async def upload_document(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> KnowledgeDocumentRead:
    document = await create_document(db, organization, file)
    process_knowledge_document.delay(document.id)
    return KnowledgeDocumentRead.model_validate(document)


@router.get("/knowledge/documents", response_model=list[KnowledgeDocumentRead])
def get_documents(
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> list[KnowledgeDocumentRead]:
    return list_documents(db, organization)


@router.post("/knowledge/documents/{document_id}/reindex", response_model=ReindexResponse)
def reindex(
    document_id: int,
    db: Session = Depends(get_db),
    organization: Organization = Depends(get_current_organization),
) -> ReindexResponse:
    document = db.get(KnowledgeDocument, document_id)
    if document is None or document.organization_id != organization.id:
        raise HTTPException(status_code=404, detail="Document not found")
    process_knowledge_document.delay(document_id)
    return ReindexResponse(document_id=document_id, status="queued")


@router.post("/selector-review", response_model=SelectorReviewResponse)
def selector_review(
    payload: SelectorReviewRequest,
    organization: Organization = Depends(get_current_organization),
) -> SelectorReviewResponse:
    _ = organization
    return review_selectors(payload)
