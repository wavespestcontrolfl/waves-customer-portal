# TODO / Follow-ups

Tracking outstanding non-blocking work that isn't yet wired into an external issue tracker.

---

## LOCAL=1 regression harness silently falls back to code defaults

**Problem:** Under Jest's LOCAL=1 mode, `loadPricingConfig()` throws silently when it can't initialize `db.js` (worktree `.env` issue, or similar dotenv/knexfile init failure), cfg becomes empty object, engine falls back to hardcoded breakpoints in `constants.js`. 6 v2 regression cases diverge from DB-backed baselines by ~$1 per pest basePrice due to 1500-sqft bracket fallback adj=-6 vs DB adj=-5.

**Discovered:** Session 9.5 investigation (2026-04-17).

**Impact:** Sessions 2-8.5 LOCAL=1 regression gates were validating stability (same output as last run), not correctness (output matches prod DB). HTTP regression against prod continues to be the authoritative correctness check. Prod engine behavior was always correct.

**Fix:** Diagnose dotenv/knexfile initialization failure in test harness. Add test-boot assertion that `loadPricingConfig()` returns non-empty cfg before running cases — surfaces future silent fallback as an explicit failure instead of silent drift.

**Priority:** Medium. HTTP regression covers the correctness gap, but LOCAL=1 is part of the Session 6 hardened workflow and should be restored to full function before Session 10.

**Referenced from:** `pricing_changelog` id=10 (Session 9).
