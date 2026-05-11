from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://workflow:workflow@localhost:5432/workflow"
    database_url_sync: str = "postgresql://workflow:workflow@localhost:5432/workflow"
    redis_url: str = "redis://localhost:6379/0"
    ai_provider: str = "openai"
    ai_api_key: str = ""
    ai_model: str = "gpt-4o-mini"
    ai_confidence_threshold: float = 0.85
    deterministic_only: bool = False
    cors_origins: list[str] = ["http://localhost:*"]
    api_key: str = "dev-api-key-change-in-production"
    secret_key: str = "change-me-to-a-random-secret"
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
