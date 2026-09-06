# Promise Keeper connection

Local implementation; deploy and activation remain separate owner steps.

The Promise Keeper reads `GET /api/integrations/commitments-worker/open?limit=50&offset=0`
using the existing `sign-request.py` signer with `key_id="hermes_commitments"`.
The dedicated secret is `LINK_WORKER_SECRET_HERMES_COMMITMENTS` on the portal
and `/data/workspace/.waves-link-worker-secret-commitments` (0600) on Hermes.
It grants only `commitments_read`; existing backlink, vendor, watchdog and
legacy bearer credentials do not grant access. Activation requires
`GATE_HERMES_WORKER=true` and `GATE_HERMES_COMMITMENTS=true`. The latter is the
lane kill switch; unset it to stop access immediately.

Walk `next_offset` while `has_more`, within the mission budget. Record each
page's observed_at and source ID, dedupe by commitment ID, and report any
unfinished page traversal as incomplete coverage. Concurrent queue changes
can shift offset pages; repeat scans but never close a case based on absence.
This source covers stored open Waves call commitments only. It does not
establish SMS/email input coverage or refresh fulfillment. `extraction_enabled`
reports the existing call extraction gate; false does not mean no historical
promises remain.

Each row supplies its obligation, due time, source call ID, evidence excerpts
and anchors, last-update version, and possible completion record references.
Truncated evidence or unresolved association hints require staff review through
`/admin/communications#tab=owed`. Quotes can contain customer information:
keep them in restricted case evidence, never the shared wiki, broad board
messages or logs. Board titles and comments use IDs/kind/deadline only.

No write capability is added: no extraction, fulfillment refresh, scheduling,
messaging, or closure mutation. The only database writes are the existing
request nonce and audit. A proposed resolution must still use the existing
approved operational action; a freshly read row is not authorization.

Validation: auth and route regressions plus the public-route scanner pass.
Migration up/down was dry-run in one rolled-back transaction against the
existing synthetic PR-3874 QA database after verifying its current Railway
preview identity and proxy. The expanded and restored CHECK definitions were
verified; no migration was applied to production.
