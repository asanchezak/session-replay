from pydantic import SecretStr
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
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:8081"]
    cors_origin_regex: str = r"chrome-extension://.*"
    api_key: SecretStr = SecretStr("dev-api-key-change-in-production")
    secret_key: SecretStr = SecretStr("change-me-to-a-random-secret")
    log_level: str = "INFO"
    debug: bool = False
    rate_limit_enabled: bool = True
    rate_limit_per_minute: int = 600
    seq_url: str = "http://localhost:5341"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    def check_insecure_defaults(self):
        if self.api_key.get_secret_value() == "dev-api-key-change-in-production":
            import warnings
            warnings.warn(
                "Using insecure default API key — set API_KEY in .env for production"
            )
        if self.secret_key.get_secret_value() == "change-me-to-a-random-secret":
            import warnings
            warnings.warn(
                "Using insecure default secret key — set SECRET_KEY in .env for production"
            )


settings = Settings()
