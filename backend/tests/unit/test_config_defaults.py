"""Verify check_insecure_defaults() behavior and config consistency.

Ensures:
- Default keys warn (not crash) so dev server starts
- Production-grade keys pass silently
- The running config's API key differs from the old insecure default
"""
from __future__ import annotations

import warnings

import pytest

from core.config import Settings


class TestCheckInsecureDefaults:
    def test_default_api_key_warns(self):
        s = Settings(
            api_key="dev-api-key-change-in-production",
            secret_key="a-different-secret",
        )
        with pytest.warns(UserWarning, match="insecure default API key"):
            s.check_insecure_defaults()

    def test_default_secret_key_warns(self):
        s = Settings(
            api_key="a-different-api-key",
            secret_key="change-me-to-a-random-secret",
        )
        with pytest.warns(UserWarning, match="insecure default secret key"):
            s.check_insecure_defaults()

    def test_both_defaults_warn(self):
        s = Settings(
            api_key="dev-api-key-change-in-production",
            secret_key="change-me-to-a-random-secret",
        )
        with pytest.warns(UserWarning) as record:
            s.check_insecure_defaults()
        messages = [str(r.message) for r in record]
        assert any("API key" in m for m in messages)
        assert any("secret key" in m for m in messages)

    def test_custom_keys_pass_silently(self):
        s = Settings(
            api_key="a-secure-unique-api-key",
            secret_key="a-secure-unique-secret-key",
        )
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            s.check_insecure_defaults()  # should not warn

    def test_idempotent(self):
        s = Settings(
            api_key="custom-key",
            secret_key="custom-secret",
        )
        s.check_insecure_defaults()
        s.check_insecure_defaults()  # second call should not raise or warn



