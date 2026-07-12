# Sweep notes — registry for the weekly automated code sweep

This file is read by the scheduled cloud audit routine ("Weekly code sweep", Saturdays)
before every run. The sweep must never re-flag anything listed here. Humans and
sessions append entries whenever a finding is rebutted, a behavior is confirmed
by-design, or a lane is closed by the owner — one line per entry, with the
PR/audit reference and date, newest first within its section.

## Rebutted findings (do not re-flag)

- Partial-refund `refund_amount` overwrite: the `charge.refunded` webhook is the
  designed reconciler (cumulative `amount_refunded`) — heals within seconds.
  (money-path audit 2026-07-06)
- estimate-engine `0.029` hardcode: `cardProcessingFeeRate`/`cardProcessingFeeEstimate`
  are write-only dead fields with zero consumers repo-wide — hygiene only, not a
  billing bug. (money-path audit 2026-07-06)
- Refund side-effect auto-reversal (#2606): parking with a named operator alert
  instead of auto-reversing is the audited design — do not re-litigate. (2026-07-11)
- Refund-cancelled prepay terms stay cancelled: revival is dispute-marker-gated
  (#2533) and the alert names the term — by design. (2026-07-11)
- Comparison-table gate (#2633): category-table CELL tone scans blocking on
  negativity is a reviewed boundary; scoping tone scans to business tables only
  was rebutted. The directed/target-scoped disparagement design is a deliberate
  precision boundary — phrasing-permutation recall gaps are known and accepted;
  named-competitor drafts never auto-publish anyway. (2026-07-11)
- SMS brand-voice r5 auto-demote proposal: rebutted — do not re-propose. (2026-07)

## By-design behaviors (not bugs)

- PDFs intentionally keep plain-text recaps/cells; AI narrative summaries and
  tech-photo cards are web-render only.
- Arrival window displays as 2 hours from `window_start` (display-only);
  `window_end` drives scheduling. Never change either side.
- `square_*` columns are legacy; Stripe is the only payment processor.
- Service-library prices use NULL (not 0) when unset — 0 triggers the $0
  admin-schedule fallback.
- Voice greeting MP3 contains the FL 934.03 recording disclosure — never remove;
  the press-1 IVR step is kept deliberately.
- Stripe Terminal reader showing "offline" between sessions is normal.
- Cloudflare Bot Fight Mode is OFF on marketing zones by design.
- SMS template rows are never deleted — deactivate via `isTemplateActive`.
- Outbound calls skip the recurring-intent classification backstop by design;
  the backstop is inbound-only (#2628).

## Known dead code (already catalogued — don't re-discover)

- `email-automations.js` is dead code (replaced by the gated treatment-automation
  lane); its test suite is likewise dead. (test-suite audit 2026-07-12)
- `intercept-brief-injection.test` has a pre-existing load failure on main. (2026-07-12)

## Already-catalogued open findings (reference, don't re-report as new)

- Test-suite false-confidence audit 2026-07-12: ~20 ranked findings including no
  CI test run, 7 DB-gated suites that never execute (incl. the only
  pricing-DB-sync test), the waveguard margin test trusting the engine's own
  costs, and unverified irrigation opt-outs — fixes await owner decision.
- Alert audit 2026-07-11: lead-webhook new_lead notification passes the CUSTOMER
  id as leadId (`server/routes/lead-webhook.js:513`); quote-promised
  notification lacks a callSid dedupe (`call-recording-processor.js` ~5288/~5341);
  churn engine alerts on `pipeline_stage=new_lead`; morning digest sums missing
  `invoice_amount` as $0.00 (`scheduler.js` ~2205).
- Morning email digest's multi-thousand unread inbox count is chronic and known.

## Closed lanes (owner-closed — do not re-propose)

- Estimate follow-up drip cadence (#2276): closed by owner; the lane is fully off.
- Reddit-astroturf-style listicle content: refused; informational lists only.
- Agronomic wiki section G: skipped by owner.
- Voice-relay Phase 2: do not re-propose (#2177 merged dark, owner activation pending).

## House rules relevant to findings

- Company name is "Waves Pest Control" — never "Waves Lawn & Pest".
- Site copy compliance: re-entry is never described as "safe", no fixed re-entry
  minutes, products are "EPA-registered".
- Payment pages must never auto-retry `/finalize`, `/setup-complete`, or `/confirm`.
- All customer-facing communications are owner-sent; automation must be gated
  behind a `GATE_*` env var, default OFF.
