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
    # Bulk results-page save: ONE daemon run selects N candidates on the search
    # results page and bulk-saves them to the project (zero profile visits → much
    # lighter anti-bot footprint than the per-candidate recruiter_save_workflow_id
    # loop). When set, _after_search fires this instead of N per-profile save runs.
    # Workflow params: search_url, project_name, target_count.
    # Env: RECRUITER_SAVE_RESULTS_WORKFLOW_ID.
    recruiter_save_results_workflow_id: str = ""
    # Remove (= ARCHIVE; Recruiter has no hard-delete from a project) a single
    # candidate from a project. Fired by POST /v1/recruiter/leads/remove when an
    # Odoo linkedin.lead is deleted: one daemon archive run locates the candidate
    # by NAME on the project pipeline, archives them, and VERIFIES they're gone;
    # on confirmed removal the terminal hook deletes the Odoo lead
    # (/akcr/api/lead_removed). Workflow params: project_url, candidate_name.
    # Env: RECRUITER_ARCHIVE_CANDIDATE_WORKFLOW_ID.
    recruiter_archive_candidate_workflow_id: str = ""
    # Archive a whole project (testing tool). Triggered on-demand (run-with-params),
    # not by the autonomous pipeline. Env: RECRUITER_ARCHIVE_PROJECT_WORKFLOW_ID.
    recruiter_archive_project_workflow_id: str = ""
    # Location facet for the advanced search. The focused boolean+location search
    # workflow needs a location to commit reliably (the location facet + explicit
    # "Run search" click is what actually executes the query; boolean-only Enter-
    # commit can leave the page on "Búsqueda vacía"). Threaded as {{location}}.
    # Env: RECRUITER_DEFAULT_LOCATION.
    recruiter_default_location: str = ""
    # How many skills the INITIAL boolean AND's (musts first, then optionals) on top
    # of the (title OR …) clause — i.e. how STRICT the first search is. The builder's
    # default is 2 (title + 2 skills); raise it for a tighter first pass on rich JDs.
    # Bounded per-position by max_tightness(spec) = title + all skills. The calibration
    # below still broadens (-1) if the tightened query returns too few. Env:
    # RECRUITER_SEARCH_START_TIGHTNESS.
    recruiter_search_start_tightness: int = 2
    # Boolean-search count calibration: target ~15; re-tune (tighten/broaden the
    # boolean) when the result count falls outside [min,max], capped at N re-runs.
    recruiter_target_count: int = 15
    recruiter_count_band_min: int = 10
    recruiter_count_band_max: int = 25
    # At most ONE calibration → ≤2 searches per position. We extract ~30 and save a
    # handful downstream regardless of the raw count, so the search count barely
    # affects the OUTPUT — chasing a tighter count costs extra searches on the
    # sensitive account for little gain. Live data: a full-stack+CR search goes
    # 670→507→206 across tightness steps and never dips under 150 in 2 reruns, so
    # max_reruns=2 always exhausted; 1 rerun gives the calibration benefit (one
    # tighten) without the 3rd search. Env: RECRUITER_MAX_SEARCH_RERUNS.
    recruiter_max_search_reruns: int = 1
    # Calibration STOP thresholds — the early-exit guards (used when max_reruns > 1):
    # finalize once the count is at/below the acceptable ceiling, or once tightening
    # stops reducing it by at least min_convergence (diminishing returns), instead of
    # mechanically burning reruns. A location-faceted tech search realistically
    # returns 50-500 even tightened; we only extract ~30 + save a handful, so a count
    # at/below the ceiling is "good enough". Env: RECRUITER_COUNT_ACCEPTABLE_MAX /
    # RECRUITER_COUNT_MIN_CONVERGENCE.
    recruiter_count_acceptable_max: int = 150
    recruiter_count_min_convergence: float = 0.35
    # Optional ABSOLUTE ceiling on how many of the extracted candidates get saved
    # to the project. 0 (default) = NO cap → save EVERY extracted candidate (the
    # count saved == the count the search extracted, itself bounded by the search
    # workflow target_count). Env: RECRUITER_MAX_SAVES_PER_POSITION.
    recruiter_max_saves_per_position: int = 0
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
