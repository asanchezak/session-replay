from services.audit import compute_event_hash, compute_seed_hash


def test_compute_event_hash_deterministic():
    h1 = compute_event_hash("abc", "click", {"selector": "#btn"}, "nonce1")
    h2 = compute_event_hash("abc", "click", {"selector": "#btn"}, "nonce1")
    assert h1 == h2


def test_different_payload_different_hash():
    h1 = compute_event_hash("abc", "click", {"a": 1}, "n1")
    h2 = compute_event_hash("abc", "click", {"a": 2}, "n1")
    assert h1 != h2


def test_different_nonce_different_hash():
    h1 = compute_event_hash("abc", "click", {"a": 1}, "n1")
    h2 = compute_event_hash("abc", "click", {"a": 1}, "n2")
    assert h1 != h2


def test_chain_integrity():
    seed = compute_seed_hash("run-1")
    h1 = compute_event_hash(seed, "click", {"btn": "submit"}, "n1")
    h2 = compute_event_hash(h1, "type", {"field": "name"}, "n2")
    h3 = compute_event_hash(h2, "navigate", {"url": "/page"}, "n3")

    assert h1 != h2 != h3
    assert len(h1) == 64
    assert len(h2) == 64
    assert len(h3) == 64


def test_tamper_detection():
    seed = compute_seed_hash("run-2")
    h1 = compute_event_hash(seed, "click", {"btn": "submit"}, "n1")
    h2 = compute_event_hash(h1, "type", {"field": "name"}, "n2")

    tampered_h2 = compute_event_hash(
        h1, "type", {"field": "EVIL_NAME"}, "n2"
    )

    assert h2 != tampered_h2


def test_seed_hash_unique_per_run():
    s1 = compute_seed_hash("run-a", "user1")
    s2 = compute_seed_hash("run-b", "user1")
    assert s1 != s2


def test_payload_sorting_stability():
    h1 = compute_event_hash("abc", "click", {"b": 2, "a": 1}, "n1")
    h2 = compute_event_hash("abc", "click", {"a": 1, "b": 2}, "n1")
    assert h1 == h2
