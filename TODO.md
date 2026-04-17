# TODO / Follow-ups

Tracking outstanding non-blocking work that isn't yet wired into an external issue tracker.

---

## ~~LOCAL=1 regression harness silently falls back to code defaults~~ ✅ RESOLVED Session 10 (2026-04-17)

**Fix landed:** commits `96b7e72` + `04fff41` + `b704e80`. Root cause was Jest NODE_ENV=test + knexfile missing `test` key → `knex(undefined)` silent-throw inside `loadPricingConfig`'s try/catch. Fixed via knexfile `test: development` alias, `db.js` loud-throw on undefined env, and boot assertion in both regression suites checking `pricing_config` fields non-null + Silver tier discount non-zero. Meta-bug caught during verification: dotenv-lazy-load made beforeAll's `!DATABASE_URL` early-return fire in LOCAL mode, bypassing the boot assertion entirely — fixed via explicit dotenv load at test-file tops. LOCAL=1 now 27/27 correctness-gated, sabotage-verified.

**Referenced from:** `pricing_changelog` id=11 (Session 10).
