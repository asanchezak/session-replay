"""
Config consistency checker.

Validates that all layers of the stack agree on the API key:
  - Backend: .env (API_KEY)
  - Extension: api.ts (DEV_DEFAULTS.apiKey)
  - Frontend: frontend/.env (VITE_API_KEY)

Run from project root:  python scripts/check-config-consistency.py
"""
import re
import sys
from pathlib import Path


def parse_dotenv(path: Path) -> dict[str, str]:
    """Parse a .env file, returning {KEY: VALUE}."""
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        result[key.strip()] = val.strip().strip("\"'")
    return result


def parse_ts_defaults(path: Path) -> dict[str, str]:
    """Parse TypeScript DEV_DEFAULTS object from api.ts."""
    if not path.exists():
        return {}
    content = path.read_text()
    defaults: dict[str, str] = {}
    # Match lines like "apiKey: "value"", "apiBase: "value"" inside DEV_DEFAULTS
    for m in re.finditer(
        r"(apiKey|apiBase|aiApiKey):\s*\"([^\"]*)\"",
        content,
    ):
        defaults[m.group(1)] = m.group(2)
    return defaults


INVALID_DEFAULTS = {
    "backend": "dev-api-key-change-in-production",
    "frontend": "dev-api-key-change-in-production",
    "extension": "dev-api-key-change-in-production",
}


def mask_secret(value: str, visible: int = 4) -> str:
    """Mask most of a secret while preserving short prefix/suffix for debugging."""
    if not value:
        return "<empty>"
    if len(value) <= visible * 2:
        return "*" * len(value)
    return f"{value[:visible]}...{value[-visible:]}"


def main() -> int:
    errors: list[str] = []
    root = Path(__file__).resolve().parent.parent

    # ── Read all three config sources ──────────────────────────────
    backend_env = parse_dotenv(root / ".env")
    frontend_env = parse_dotenv(root / "frontend" / ".env")
    extension_ts = parse_ts_defaults(root / "extension" / "src" / "background" / "api.ts")

    backend_key = backend_env.get("API_KEY", "")
    frontend_key = frontend_env.get("VITE_API_KEY", "")
    extension_key = extension_ts.get("apiKey", "")

    print("─" * 48)
    print("Config Consistency Check")
    print("─" * 48)
    print(f"  Backend   (.env)                    API_KEY      = {mask_secret(backend_key)}")
    print(f"  Frontend  (frontend/.env)           VITE_API_KEY = {mask_secret(frontend_key)}")
    print(f"  Extension (extension/.../api.ts)    DEV_DEFAULTS = {mask_secret(extension_key)}")
    print("─" * 48)

    # ── Check: no source uses the old insecure default ─────────────
    if backend_key == INVALID_DEFAULTS["backend"]:
        errors.append(
            f"Backend .env uses the old insecure default: '{INVALID_DEFAULTS['backend']}'. "
            "Set API_KEY to a unique value."
        )
    if frontend_key == INVALID_DEFAULTS["frontend"]:
        errors.append(
            f"Frontend .env uses the old insecure default: '{INVALID_DEFAULTS['frontend']}'. "
            "Set VITE_API_KEY to match the backend API_KEY."
        )
    if extension_key == INVALID_DEFAULTS["extension"]:
        errors.append(
            f"Extension DEV_DEFAULTS.apiKey uses the old insecure default: "
            f"'{INVALID_DEFAULTS['extension']}'. Update it to match the backend API_KEY."
        )

    # ── Check: all three agree ─────────────────────────────────────
    resolved = backend_key or extension_key  # pick whichever is set
    if not resolved:
        errors.append("No API key found anywhere — at least one layer must define it.")
    else:
        if backend_key and backend_key != resolved:
            errors.append(
                "Backend API_KEY ({}) differs from reference ({}).".format(
                    mask_secret(backend_key), mask_secret(resolved)
                )
            )
        if frontend_key and frontend_key != resolved:
            errors.append(
                "Frontend VITE_API_KEY ({}) differs from reference ({}).".format(
                    mask_secret(frontend_key), mask_secret(resolved)
                )
            )
        if extension_key and extension_key != resolved:
            errors.append(
                "Extension DEV_DEFAULTS.apiKey ({}) differs from reference ({}).".format(
                    mask_secret(extension_key), mask_secret(resolved)
                )
            )

    # ── Check: frontend .env exists and has a key ──────────────────
    if not (root / "frontend" / ".env").exists():
        errors.append(
            "frontend/.env does not exist. "
            "Create it with VITE_API_KEY=<key> matching the backend API_KEY."
        )
    if not frontend_key:
        errors.append("frontend/.env has no VITE_API_KEY set.")

    print()
    if errors:
        print("FAILURES:")
        for e in errors:
            print(f"  ✗  {e}")
        print()
        return 1

    print("  ✓  All layers agree on the API key.")
    print("  ✓  No layer uses the old insecure default.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
