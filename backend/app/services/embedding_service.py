import hashlib
import random

from openai import OpenAI

from app.core.config import settings


class EmbeddingProvider:
    def embed(self, text: str) -> list[float]:
        raise NotImplementedError


class MockEmbeddingProvider(EmbeddingProvider):
    def embed(self, text: str) -> list[float]:
        seed = int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:16], 16)
        rng = random.Random(seed)
        return [rng.uniform(-1.0, 1.0) for _ in range(settings.embedding_dimensions)]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    def __init__(self) -> None:
        self.client = OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url or None)

    def embed(self, text: str) -> list[float]:
        response = self.client.embeddings.create(
            model=settings.openai_embedding_model,
            input=text[:8000],
            dimensions=settings.embedding_dimensions,
        )
        # 兼容部分代理/自建服务返回非标准结构的情况,给出清晰错误而非 AttributeError。
        if isinstance(response, str):
            raise RuntimeError(
                f"Embedding API returned a plain string instead of an embedding object. "
                f"Check openai_base_url/openai_embedding_model config. Response preview: {response[:200]}"
            )
        if not getattr(response, "data", None):
            raise RuntimeError(
                f"Embedding API returned an object without 'data' field. "
                f"Type={type(response).__name__}, preview={str(response)[:200]}"
            )
        return response.data[0].embedding


def get_embedding_provider() -> EmbeddingProvider:
    if settings.openai_api_key:
        return OpenAIEmbeddingProvider()
    return MockEmbeddingProvider()
