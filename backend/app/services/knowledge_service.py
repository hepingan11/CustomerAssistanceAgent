import re

from fastapi import HTTPException, UploadFile
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import IngestionJob, KnowledgeChunk, KnowledgeDocument, Organization
from app.services.embedding_service import get_embedding_provider


def clean_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n")).strip()


def chunk_text(text: str, chunk_size: int = 900, overlap: int = 120) -> list[str]:
    text = clean_text(text)
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end].strip())
        if end == len(text):
            break
        start = max(0, end - overlap)
    return [chunk for chunk in chunks if chunk]


async def create_document(db: Session, organization: Organization, file: UploadFile) -> KnowledgeDocument:
    filename = file.filename or "document.txt"
    if not filename.lower().endswith((".txt", ".md")):
        raise HTTPException(status_code=400, detail="Only txt and md files are supported")
    content = (await file.read()).decode("utf-8")
    document = KnowledgeDocument(
        organization_id=organization.id,
        filename=filename,
        content=content,
        status="pending",
    )
    db.add(document)
    db.flush()
    db.add(IngestionJob(organization_id=organization.id, document_id=document.id, status="queued"))
    db.commit()
    db.refresh(document)
    return document


def reindex_document(db: Session, document_id: int) -> None:
    document = db.get(KnowledgeDocument, document_id)
    if document is None:
        raise ValueError(f"Document {document_id} not found")
    document.status = "indexing"
    db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document.id))
    db.commit()

    provider = get_embedding_provider()
    for index, chunk in enumerate(chunk_text(document.content)):
        db.add(
            KnowledgeChunk(
                organization_id=document.organization_id,
                document_id=document.id,
                content=chunk,
                embedding=provider.embed(chunk),
                chunk_metadata={"chunk_index": index},
            )
        )
    document.status = "ready"
    db.commit()


def list_documents(db: Session, organization: Organization) -> list[KnowledgeDocument]:
    return list(
        db.scalars(
            select(KnowledgeDocument)
            .where(KnowledgeDocument.organization_id == organization.id)
            .order_by(KnowledgeDocument.created_at.desc())
        )
    )
