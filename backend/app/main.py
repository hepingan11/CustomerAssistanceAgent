from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.core.database import SessionLocal
from app.models import Organization

app = FastAPI(title="Customer Assistance Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.on_event("startup")
def ensure_default_organization() -> None:
    db = SessionLocal()
    try:
        organization = db.query(Organization).filter(Organization.api_key == settings.default_api_key).first()
        if organization is None:
            db.add(Organization(name="Default Organization", api_key=settings.default_api_key))
            db.commit()
    finally:
        db.close()


app.include_router(router, prefix="/api")
