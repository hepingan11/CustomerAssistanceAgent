from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ConversationCreate(BaseModel):
    external_id: str = Field(..., min_length=1)
    page_url: str | None = None
    title: str | None = None
    customer_external_id: str | None = None
    customer_name: str | None = None


class ConversationRead(BaseModel):
    id: int
    external_id: str
    page_url: str | None
    title: str | None

    class Config:
        from_attributes = True


class MessageCreate(BaseModel):
    conversation_id: int
    sender_type: Literal["customer", "agent", "unknown"] = "unknown"
    sender_name: str | None = None
    content: str = Field(..., min_length=1)
    source: str = "browser_extension"
    source_message_id: str | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    # 上下文 token 预算上限(字符数近似)。None 表示用后端默认值。
    context_budget: int | None = None


class MessageRead(BaseModel):
    id: int
    conversation_id: int
    sender_type: str
    sender_name: str | None
    content: str
    created_at: datetime
    duplicate: bool = False

    class Config:
        from_attributes = True


class SuggestionRead(BaseModel):
    id: int | None = None
    conversation_id: int
    content: str | None = None
    status: str
    created_at: datetime | None = None


class ContextPreviewMessage(BaseModel):
    id: int
    sender_type: str
    sender_name: str | None
    content: str
    created_at: datetime


class ContextPreviewChunk(BaseModel):
    id: int
    content: str
    score: float | None = None


class ContextPreviewResponse(BaseModel):
    conversation_id: int
    budget: int
    used_tokens: int
    total_messages: int
    kept_messages: int
    total_chunks: int
    kept_chunks: int
    messages: list[ContextPreviewMessage]
    chunks: list[ContextPreviewChunk]
    prompt: str
    chunk_error: str | None = None


class KnowledgeDocumentRead(BaseModel):
    id: int
    filename: str
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class ReindexResponse(BaseModel):
    document_id: int
    status: str


class SelectorReviewRequest(BaseModel):
    page_url: str | None = None
    title: str | None = None
    sample_text: str | None = None
    selectors: dict[str, str] = Field(default_factory=dict)
    selector_stats: dict[str, Any] = Field(default_factory=dict)
    extraction_preview: list[dict[str, Any]] = Field(default_factory=list)
    dom_summary: list[dict[str, Any]] = Field(default_factory=list)
    auto_detect_result: dict[str, Any] | None = None


class SelectorReviewResponse(BaseModel):
    status: str
    summary: str
    recommended_selectors: dict[str, str] = Field(default_factory=dict)
    issues: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    raw_response: str | None = None
