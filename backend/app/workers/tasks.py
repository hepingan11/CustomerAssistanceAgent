from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.models import IngestionJob, KnowledgeDocument
from app.services.knowledge_service import reindex_document
from app.services.rag_service import generate_suggestion


@celery_app.task(name="process_knowledge_document")
def process_knowledge_document(document_id: int) -> None:
    db = SessionLocal()
    try:
        document = db.get(KnowledgeDocument, document_id)
        if document is None:
            raise ValueError(f"Document {document_id} not found")
        job = IngestionJob(document_id=document_id, organization_id=document.organization_id, status="running")
        db.add(job)
        db.commit()
        reindex_document(db, document_id)
        job.status = "done"
        db.commit()
    except Exception as exc:
        db.rollback()
        document = db.get(KnowledgeDocument, document_id)
        if document:
            document.status = "failed"
            db.add(IngestionJob(organization_id=document.organization_id, document_id=document_id, status="failed", error=str(exc)))
            db.commit()
        raise
    finally:
        db.close()


@celery_app.task(name="generate_ai_suggestion")
def generate_ai_suggestion(conversation_id: int, trigger_message_id: int) -> None:
    db = SessionLocal()
    try:
        generate_suggestion(db, conversation_id, trigger_message_id)
    finally:
        db.close()
