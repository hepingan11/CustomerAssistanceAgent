import hashlib
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Conversation, Customer, Message, Organization

SENSITIVE_KEYS = {"cookie", "cookies", "token", "authorization", "password", "secret"}


def scrub_payload(payload: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in payload.items():
        if key.lower() in SENSITIVE_KEYS:
            safe[key] = "[redacted]"
        elif isinstance(value, dict):
            safe[key] = scrub_payload(value)
        else:
            safe[key] = value
    return safe


def get_or_create_conversation(
    db: Session,
    organization: Organization,
    external_id: str,
    page_url: str | None = None,
    title: str | None = None,
    customer_external_id: str | None = None,
    customer_name: str | None = None,
) -> Conversation:
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.organization_id == organization.id,
            Conversation.external_id == external_id,
        )
    )
    if conversation:
        conversation.page_url = page_url or conversation.page_url
        conversation.title = title or conversation.title
        db.commit()
        db.refresh(conversation)
        return conversation

    customer = None
    if customer_external_id or customer_name:
        customer = Customer(
            organization_id=organization.id,
            external_id=customer_external_id,
            name=customer_name,
        )
        db.add(customer)
        db.flush()
    conversation = Conversation(
        organization_id=organization.id,
        customer_id=customer.id if customer else None,
        external_id=external_id,
        page_url=page_url,
        title=title,
    )
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


def stable_message_id(conversation_id: int, content: str, sender_name: str | None) -> str:
    raw = f"{conversation_id}|{sender_name or ''}|{content}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def create_message(
    db: Session,
    conversation_id: int,
    sender_type: str,
    sender_name: str | None,
    content: str,
    source: str,
    source_message_id: str | None,
    raw_payload: dict[str, Any],
) -> tuple[Message, bool]:
    source_id = source_message_id or stable_message_id(conversation_id, content, sender_name)
    message = Message(
        conversation_id=conversation_id,
        sender_type=sender_type,
        sender_name=sender_name,
        content=content.strip(),
        source=source,
        source_message_id=source_id,
        raw_payload=scrub_payload(raw_payload),
    )
    db.add(message)
    try:
        db.commit()
        db.refresh(message)
        return message, False
    except IntegrityError:
        db.rollback()
        existing = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation_id,
                Message.source_message_id == source_id,
            )
        )
        if existing is None:
            raise
        return existing, True
