from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Customer Assistance Agent"
    database_url: str = "postgresql+psycopg://postgres:postgres@postgres:5432/customer_assistance"
    redis_url: str = "redis://redis:6379/0"
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_chat_model: str = "gpt-4o-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    default_api_key: str = "dev-api-key"
    recent_message_limit: int = 12
    # 上下文 token 预算上限(单位:字符,近似 token 估算)。前端可选 256k/512k/1M。
    default_context_budget: int = 256 * 1024
    max_context_budget: int = 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
