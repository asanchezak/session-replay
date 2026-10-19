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
    # Add a "Contactado para <posición>" NOTE to a project's candidates (bulk) AND move
    # them to the native "contacted" pipeline stage — the LinkedIn-side markers of "already
    # contacted". GATED by `save` (false=preview/STOP, true=save the note + move stage).
    # Triggered standalone (POST /v1/recruiter/jobs/{id}/add-note + Odoo button) and chained
    # after a real message send (_after_message). Defaulted to the deployed id so it works
    # after a plain backend redeploy (no box env change). Workflow params: project_url,
    # note_text, save. Env: RECRUITER_NOTE_WORKFLOW_ID.
    recruiter_note_workflow_id: str = "37a8f06d-4bfc-4fbd-9c45-923ab11a598c"
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
    # Add a project's RECOMMENDED matches (LinkedIn Automated Sourcing) to the pipeline.
    # Triggered via POST /v1/recruiter/jobs/{id}/save-recommendations; the terminal hook
    # pushes the added candidates as linkedin.lead. Env: RECRUITER_RECOMMENDATIONS_WORKFLOW_ID.
    recruiter_recommendations_workflow_id: str = ""
    # PUSH a candidate's GLOBAL notes to LinkedIn (push-only — we don't pull LinkedIn's).
    # Triggered via POST /v1/recruiter/candidates/sync-notes (Odoo candidate button). Adds
    # each unsynced Odoo note by selecting the candidate (by name) in a project pipeline and
    # adding the note there (strategy recruiter_candidate_note_add); the terminal hook marks
    # the Odoo note synced. Params: project_url, candidate_name, note_text, save.
    # Live-verified 2026-06-24. Env: RECRUITER_NOTES_SYNC_WORKFLOW_ID.
    recruiter_notes_sync_workflow_id: str = "1f17ab64-8e2b-4046-a11b-9034b1e8818a"
    # DEMO button (Odoo "Demo" on hr.job): reset the LinkedIn project to ONLY the demo
    # profile (archive ALL → add the profile), then optionally send the templated InMail.
    # Reuses the standalone archive-all / add-profile sub-workflows; defaulted to their
    # deployed IDs so the demo works after a plain backend redeploy (no box env change).
    # Env: RECRUITER_ARCHIVE_ALL_WORKFLOW_ID / RECRUITER_ADD_PROFILE_WORKFLOW_ID.
    recruiter_archive_all_workflow_id: str = "511ceaab-34c2-4d8b-9241-725a61e1cc32"
    recruiter_add_profile_workflow_id: str = "f003f090-d74a-41bc-90a9-67f5fd603a5d"
    # The single profile the demo keeps (public /in/ URL; bridges to the Recruiter
    # profile in a logged-in seat). Default = Andrey (your own profile) so the demo
    # never messages a real candidate. Env: RECRUITER_DEMO_PROFILE_URL/_NAME.
    recruiter_demo_profile_url: str = "https://www.linkedin.com/in/crandrey/"
    recruiter_demo_profile_name: str = "Andrey Sanchez"
    # Safety cap on the demo archive-all loop (each pass clears ~15-25 within its 175s
    # budget; the loop re-enqueues while the project still has active candidates).
    recruiter_demo_archive_rounds: int = 6
    # Location facet for the advanced search. The focused boolean+location search
    # workflow needs a location to commit reliably (the location facet + explicit
    # "Run search" click is what actually executes the query; boolean-only Enter-
    # commit can leave the page on "Búsqueda vacía"). Threaded as {{location}}.
    # Env: RECRUITER_DEFAULT_LOCATION.
    recruiter_default_location: str = ""
    # Maps the Odoo hr.job.job_location selection (cr/latam/global) to the LinkedIn
    # location facet spec: ";"-separated PLACES, each with "|"-separated spellings (the
    # /talent seat flips ES↔EN). Every place must be a real Recruiter geo — the facet
    # strategy commits only an EXACT typeahead match and FAILS the run when nothing
    # applies, instead of silently searching the planet.
    #
    # `latam` used to be the single string "Latin America", which Recruiter's candidate-
    # location typeahead does not offer: the old workflow typed it, matched nothing,
    # clicked nothing, and the run sourced WORLDWIDE while Odoo said `latam` (jobs
    # 296/297/301 → candidates from India, Pakistan, Ukraine, Australia, the US). LATAM
    # is therefore enumerated country by country.
    #
    # "" means "skip the location facet entirely" (a deliberately worldwide position).
    # An unknown/empty job_location falls back to recruiter_default_location. Pydantic
    # parses the env value as JSON. Env: RECRUITER_LOCATION_MAP.
    recruiter_location_map: dict[str, str] = {
        "cr": "Costa Rica",
        # ALL of Latin America, verified term by term against the live typeahead (probe
        # workflow "location typeahead PROBE", 2026-09-08/09): every one of these
        # resolves to an exact country suggestion, while "Latin America" /
        # "Latinoamérica" / "América Latina" return ZERO suggestions — which is the whole
        # reason this is a country list. Spanish spelling first (the seat's current
        # language, so the match lands on the first try); the English alternate covers a
        # seat that flips. Ordered by market size: the facet strategy applies them in
        # order and reports any it could not reach inside its time budget, so a slow seat
        # truncates the smallest markets rather than the biggest.
        # Cuba and Puerto Rico are probe-verified too but deliberately OUT (no practical
        # hiring path / US jurisdiction) — add them here if that changes.
        # Cost: ~3.8s per place on the live seat (measured), so 18 places ≈ 69s of the
        # facet step's 95s budget inside a ~145s search run (240s run watchdog).
        "latam": (
            "Costa Rica;México|Mexico;Colombia;Argentina;Brasil|Brazil;Chile;"
            "Perú|Peru;Uruguay;Guatemala;Panamá|Panama;"
            "República Dominicana|Dominican Republic;Ecuador;"
            "Bolivia;Paraguay;Venezuela;El Salvador;Honduras;Nicaragua"
        ),
        "global": "",
    }
    # PER-POSITION geography override, keyed by the Odoo hr.job id, in the same
    # ";"/"|" spec as recruiter_location_map. Wins over the job_location map, because a
    # position can hire in a SUBSET of its region while Odoo's job_location selection
    # only offers cr/latam/global: job 296 sources data engineers in Colombia, Mexico,
    # Costa Rica, Brasil and Peru only, though the position is LATAM.
    #
    # A JSON object, kept as a STRING and parsed by recruiter_job_locations_map (below)
    # on purpose: this is a live prod env var, and an unset/empty value must not be a
    # container-crashing validation error the way an empty dict[str,str] field would be.
    # Env: RECRUITER_JOB_LOCATIONS, e.g.
    #   {"296":"Colombia;Mexico;Costa Rica;Brasil|Brazil;Peru"}
    # The self-service home for this is an hr.job field on the Odoo side (needs akcr) —
    # see docs/recruiter-subworkflows.md.
    recruiter_job_locations: str = ""
    # EVERY search also requires a spoken language ("que sepan inglés", operator
    # directive 2026-09-09). Same ";"/"|" spec as the location facets: the seat answers
    # in ITS OWN language, and typing "English" into a Spanish seat's language typeahead
    # finds NOTHING (probe-verified) — hence both spellings.
    # Empty ⇒ no language facet at all (the workflow step skips).
    # Env: RECRUITER_SEARCH_LANGUAGE.
    recruiter_search_language: str = "Inglés|English"
    # Proficiency floor. LinkedIn's ES/EN ladder is Básico / Competente / Nivel
    # profesional / Nivel profesional avanzado / Nativo o bilingüe = Elementary /
    # Limited working / Professional working / FULL PROFESSIONAL / Native or bilingual.
    # Empty leaves it at "Cualquiera" (any). Env: RECRUITER_SEARCH_LANGUAGE_PROFICIENCY.
    recruiter_search_language_proficiency: str = "Nivel profesional avanzado|Full Professional"
    # Facet MODE. LinkedIn defaults a new language to "Puede tener" ("can have"), which
    # only RANKS — it does not exclude anyone. "Debe tener"/"Must have" is what makes the
    # language an actual requirement. Empty ⇒ leave LinkedIn's default.
    # Env: RECRUITER_SEARCH_LANGUAGE_MODE.
    recruiter_search_language_mode: str = "Debe tener|Must have"
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
    # ABSOLUTE ceiling on how many of the extracted candidates get saved to the project
    # (== linkedin.lead rows pushed to Odoo). PRODUCTION = 6: a small, deliberate shortlist
    # per position. 0 = NO cap (save every extracted). Env: RECRUITER_MAX_SAVES_PER_POSITION.
    recruiter_max_saves_per_position: int = 6
    # Blacklist post-add sweep: max NEW (post-dedup) archive runs enqueued per search
    # run for blacklisted people who slipped into the project via the bulk save. Bounds
    # the anti-bot load on the sensitive seat; the remainder drains over subsequent
    # searches (re-detection + dedup). Env: RECRUITER_MAX_SWEEP_ARCHIVES_PER_RUN.
    recruiter_max_sweep_archives_per_run: int = 10
    # Bulk outreach batching. LinkedIn's composer reports ineligible recipients ("N recipients
    # cannot be contacted more than once within 24 hours", "…contacted by someone on your team")
    # as a COUNT ONLY and silently drops them, so a batch showing any such notice is skipped
    # WHOLE to keep messaged == noted == moved exact. Small batches keep that collateral small.
    # Env: RECRUITER_MESSAGE_BATCH_SIZE.
    recruiter_message_batch_size: int = 5
    # A send spans many chained runs (each bounded by the daemon's 240s per-step watchdog).
    # Hard stop on the chain length so a pathological loop can't run forever.
    # Env: RECRUITER_MESSAGE_MAX_CONTINUATIONS.
    recruiter_message_max_continuations: int = 40
    # AUTO-OUTREACH: message newly-added candidates without a human pressing the Odoo button.
    # Fires from the recommendations terminal hook (that cron adds ~6 candidates every 30-90
    # min). This sends REAL InMail autonomously on a sensitive account, so it is guard-heavy:
    # it only ever reuses copy a human already sent for that position, and it is bounded by the
    # daily cap below. KILL SWITCH: set false + restart the backend.
    # Env: RECRUITER_AUTO_MESSAGE_ENABLED.
    recruiter_auto_message_enabled: bool = True
    # Max InMails per position per ROLLING 24h from the automation (manual sends count toward
    # it too, so a human blast can't be doubled). Passed as max_recipients, which also disables
    # the send's run-chaining — one tick can never fan out. NOTE: per POSITION, while credits
    # and LinkedIn's limits are per ACCOUNT; revisit as a global cap if several positions
    # switch on. Env: RECRUITER_AUTO_MESSAGE_DAILY_CAP.
    recruiter_auto_message_daily_cap: int = 20
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

    @property
    def recruiter_job_locations_map(self) -> dict[str, str]:
        """RECRUITER_JOB_LOCATIONS parsed: {job_id: location spec}. Empty or malformed
        degrades to {} (the job_location map then applies) instead of taking the backend
        down — the caller logs the miss."""
        raw = (self.recruiter_job_locations or "").strip()
        if not raw:
            return {}
        import json
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        if not isinstance(parsed, dict):
            return {}
        return {str(k): str(v) for k, v in parsed.items()}

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
