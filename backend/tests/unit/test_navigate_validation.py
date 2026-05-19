"""Unit tests for navigate mismatch detection logic."""
from urllib.parse import urlparse


def _hostnames_match(expected_url: str, actual_url: str) -> bool:
    try:
        return urlparse(expected_url).hostname == urlparse(actual_url).hostname
    except Exception:
        return True


def test_mismatch_different_domain():
    assert not _hostnames_match("https://speedtest.net", "https://google.com")


def test_no_mismatch_same_domain_different_path():
    assert _hostnames_match("https://speedtest.net/es", "https://speedtest.net/en")


def test_no_mismatch_same_domain_with_query():
    assert _hostnames_match("https://speedtest.net", "https://speedtest.net?ref=foo")


def test_no_mismatch_subdomain_considered_different():
    assert not _hostnames_match("https://speedtest.net", "https://www.speedtest.net")


def test_no_mismatch_http_vs_https_same_host():
    assert _hostnames_match("http://speedtest.net", "https://speedtest.net")


def test_mismatch_login_page():
    assert not _hostnames_match("https://app.example.com/dashboard", "https://login.example.com/sign-in")


def test_mismatch_404_different_domain():
    assert not _hostnames_match("https://speedtest.net", "https://error.cloudflare.com/1001")


def test_empty_actual_url_returns_false():
    # When actual URL can't be parsed, mismatch detection returns False (no valid comparison)
    assert not _hostnames_match("https://speedtest.net", "")
