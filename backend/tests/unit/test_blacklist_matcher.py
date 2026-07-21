"""Unit tests for the blacklist name-normalizer + matcher.

`normalize_name` is a SHARED CONTRACT with akcr `linkedin.candidate._normalize_name`
— if these two ever drift, name matching silently fails. These tests pin the exact
folding behavior so a regression is caught here.
"""
from services.blacklist_matcher import BlacklistMatcher, normalize_name


class TestNormalizeName:
    def test_empty_and_none(self):
        assert normalize_name(None) == ""
        assert normalize_name("") == ""
        assert normalize_name("   ") == ""

    def test_accent_fold(self):
        assert normalize_name("José Peña") == "jose pena"
        assert normalize_name("jose pena") == "jose pena"
        assert normalize_name("Müller") == "muller"

    def test_casefold(self):
        assert normalize_name("JOHN SMITH") == "john smith"
        # casefold (not lower) expands ß → ss
        assert normalize_name("Straße") == "strasse"

    def test_punctuation_folds_to_space(self):
        assert normalize_name("O'Brien-Smith") == "o brien smith"
        assert normalize_name("J. R. R. Tolkien") == "j r r tolkien"
        assert normalize_name("Anne-Marie") == "anne marie"

    def test_whitespace_collapse(self):
        assert normalize_name("  John   Smith  ") == "john smith"
        assert normalize_name("John\tSmith\n") == "john smith"

    def test_digits_survive(self):
        assert normalize_name("Agent 007") == "agent 007"

    def test_non_latin_letters_survive(self):
        # isalnum is Unicode-aware, so a Cyrillic name is not nuked to empty.
        assert normalize_name("Иван") == normalize_name("иван") != ""


class TestBlacklistMatcher:
    def test_empty_is_falsy(self):
        assert not BlacklistMatcher([])
        assert not BlacklistMatcher(None)
        assert len(BlacklistMatcher([])) == 0

    def test_name_hit(self):
        m = BlacklistMatcher([{"name": "José Peña", "normalized_name": "jose pena"}])
        assert m.is_blacklisted("Jose Pena") == (True, "name")
        # a different display form still normalizes to the same key
        assert m.is_blacklisted("JOSÉ  PEÑA") == (True, "name")
        assert m.is_blacklisted("Someone Else") == (False, "")

    def test_url_hit(self):
        m = BlacklistMatcher([{
            "name": "X", "normalized_name": "x",
            "profile_url": "https://www.linkedin.com/talent/profile/AEMAA123",
        }])
        assert m.is_blacklisted("Nobody",
                                "https://www.linkedin.com/talent/profile/AEMAA123?foo=1") == (True, "url")
        # case-insensitive on the URL side
        assert m.is_blacklisted("Nobody",
                                "https://www.linkedin.com/talent/profile/aemaa123") == (True, "url")

    def test_synthetic_url_never_url_matches_but_name_does(self):
        m = BlacklistMatcher([{
            "name": "John Smith", "normalized_name": "john smith",
            "profile_url": "blacklist://name/john smith", "synthetic": True,
        }])
        # the synthetic URL is not treated as a real link
        assert m.is_blacklisted("Nobody", "blacklist://name/john smith") == (False, "")
        # but the name still matches
        assert m.is_blacklisted("John Smith") == (True, "name")

    def test_trusts_odoo_normalized_name_as_source_of_truth(self):
        # The Odoo-provided normalized_name is used verbatim — so a lookup matches it
        # even when the entry's `name` field is missing/unusable (the lookup name is
        # normalized locally and compared against Odoo's stored key).
        m = BlacklistMatcher([{"name": "", "normalized_name": "jose pena"}])
        assert m.is_blacklisted("José Peña") == (True, "name")

    def test_local_fallback_when_normalized_name_absent(self):
        # Entries predating the stored field (no normalized_name) still match via the
        # locally re-normalized `name`.
        m = BlacklistMatcher([{"name": "José Peña"}])
        assert m.is_blacklisted("jose pena") == (True, "name")

    def test_missing_name_no_url_is_skipped(self):
        m = BlacklistMatcher([{"name": "", "normalized_name": ""}])
        assert not m
