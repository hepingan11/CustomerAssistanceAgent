from openai import OpenAI

from app.core.config import settings


class LLMProvider:
    model_name = "mock"

    def generate(self, prompt: str) -> str:
        raise NotImplementedError


class MockLLMProvider(LLMProvider):
    model_name = "mock-provider"

    def generate(self, prompt: str) -> str:
        return (
            "Suggested reply: Hello, I have reviewed your question. Based on the current knowledge base, "
            "please first confirm the customer's exact request and related order or account information, "
            "then provide the matching handling steps. If escalation is needed, politely tell the customer "
            "that support will continue to follow up."
        )


class OpenAILLMProvider(LLMProvider):
    def __init__(self) -> None:
        self.client = OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url or None)
        self.model_name = settings.openai_chat_model

    def generate(self, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a customer-support assistant. Generate suggestions only; "
                        "never send messages automatically."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content or ""


def get_llm_provider() -> LLMProvider:
    if settings.openai_api_key:
        return OpenAILLMProvider()
    return MockLLMProvider()
