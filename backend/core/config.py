from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://workflow:workflow@localhost:5432/workflow"
    database_url_sync: str = "postgresql://workflow:workflow@localhost:5432/workflow"
    redis_url: str = "redis://localhost:6379/0"
    ai_provider: str = "openai"
    ai_api_key: str = ""
    ai_model: str = "gpt-4o-mini"
    ai_openai_base_url: str = "https://api.openai.com/v1"
    ai_confidence_threshold: float = 0.85
    deterministic_only: bool = False
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:8081"]
    cors_origin_regex: str = r"chrome-extension://.*"
    api_key: SecretStr = SecretStr("dev-api-key-change-in-production")
    secret_key: SecretStr = SecretStr("change-me-to-a-random-secret")
    # Daemon routing: LinkedIn flows are always pinned to this operator's daemon
    # (the host that holds the LinkedIn session). Other runs go to the requesting
    # operator's daemon (origin.target_operator). Env: LINKEDIN_OPERATOR.
    linkedin_operator: str = "fernanda"
    # Recruiter (/talent) automation pipeline: the parameterized sub-workflows the
    # RecruiterPipelineService chains on a new Odoo position (create project →
    # search → save candidates). Set these to the IDs of the parameterized
    # workflows once created. Env: RECRUITER_{CREATE_PROJECT,SEARCH,SAVE}_WORKFLOW_ID.
    recruiter_create_project_workflow_id: str = ""
    recruiter_search_workflow_id: str = ""
    recruiter_save_workflow_id: str = ""
    recruiter_message_workflow_id: str = ""
    recruiter_advanced_search_workflow_id: str = ""
    # Boolean-search count calibration: target ~15; re-tune (tighten/broaden the
    # boolean) when the result count falls outside [min,max], capped at N re-runs.
    recruiter_target_count: int = 15
    recruiter_count_band_min: int = 10
    recruiter_count_band_max: int = 25
    recruiter_max_search_reruns: int = 2
    # Cap how many of the search's candidates get auto-saved to the project per
    # position (each save is its own daemon run). 0 = use the payload's candidate_count.
    recruiter_max_saves_per_position: int = 5
    log_level: str = "INFO"
    debug: bool = False
    rate_limit_enabled: bool = True
    # Higher default to accommodate dashboard polling and extension traffic.
    rate_limit_per_minute: int = 6000
    seq_url: str = "http://localhost:5341"
    ai_step_recovery_window_seconds: int = 900
    ai_timeout_decision_history_limit: int = 6
    vision_enabled: bool = True
    vision_max_bytes: int = 500_000
    vision_baseline_every_n: int = 5
    vision_high_detail_on_failure: bool = True

    # Artifact storage (screenshots, HTML captures). Defaults to the local
    # filesystem under backend/artifact_storage. Without these, StorageService
    # raised AttributeError → every artifact upload 500'd.
    storage_protocol: str = "file"
    storage_path: str = "artifact_storage"
    storage_options: dict = {}

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v):
        """Accept CORS_ORIGINS as a comma-separated string (operator-friendly,
        e.g. for adding a Tailscale dashboard origin) in addition to a JSON
        list. Empty -> []."""
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return []
            if s.startswith("["):
                import json
                return json.loads(s)
            return [o.strip() for o in s.split(",") if o.strip()]
        return v

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
