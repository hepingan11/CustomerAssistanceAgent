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
        return response.data[0].embedding


def get_embedding_provider() -> EmbeddingProvider:
    if settings.openai_api_key:
        return OpenAIEmbeddingProvider()
    return MockEmbeddingProvider()
