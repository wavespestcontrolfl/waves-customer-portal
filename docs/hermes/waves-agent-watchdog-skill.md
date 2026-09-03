# Hermes Skill — Waves Agent Watchdog

**Paste this into the Hostinger Hermes dashboard → Skills tab → category WAVES.**
Give it its own profile (`hermes-watchdog`): its own signing key, read-only
scope, manual approvals. It is the *first* lane from the "Hermes at Waves"
plan because it is the one thing an agent inside Railway cannot do — notice
that Railway, the database, or the scheduler is down.

This skill NEVER acts on the portal. It reads one health snapshot, decides
whether anything is NEWS, and pages Adam on Telegram. Actions (release a
claim, pause a lane) arrive with the portal's agent-control S4 phase; until
then the only remedy is a human.

---

## What it watches (all computed by the portal, none by the model)

`GET {PORTAL_URL}/api/integrations/watchdog-worker/status` returns:

```json
{
  "observed_at": "2026-09-03T14:10:00.000Z",
  "environment": "production",
  "uptime_s": 86400,
  "database": { "ok": true, "latency_ms": 4 },
  "scheduler": { "available": true, "heartbeat_job": "hermes-watchdog-liveness",
                 "last_tick_at": "2026-09-03T14:05:00.000Z", "age_minutes": 5,
                 "silent_after_minutes": 60, "ok": true },
  "jobs": { "available": true, "total": 61, "unhealthy": 1,
            "items": [ { "job": "geocoder-backstop", "state": "failing",
                         "last_success_age_minutes": 190, "consecutive_failures": 3 } ] },
  "ops_queue": { "available": true, "pending": 12, "parked": 40, "failed": 2,
                 "lanes": [ { "key": "calls", "pending": 0, "parked": 1, "failed": 2, "error": false } ] },
  "link_worker": { "available": true, "last_claim_at": "…", "last_report_at": null,
                   "open_leases": 1, "stale_leases": 1 },
  "verdict": "attention",
  "reasons": [ "job:geocoder-backstop:failing", "ops:calls:failed", "link_worker:stale_leases" ]
}
```

- `scheduler` is the prompt heartbeat: the portal's own 23-min liveness cron
  ticks whether or not the lane gate is on, so `ok: false` (`scheduler:silent`)
  means the portal process is up but its crons are not running — the case the
  job classifier below would take eight days to notice.
- `jobs.items` lists only unhealthy crons (`failing` / `stuck` / `stale`) — the
  same classifier the portal's Agents → Queue tab and the Intelligence Bar use.
- `ops_queue` is **counts only**. Item titles never cross the wire (customer
  names live there), and neither does a job's error text — open the portal's
  Agents → Queue tab for both. A sub-read that fails says `available: false`
  and nothing else (and becomes a `<read>:unavailable` reason). The queue is
  read whether or not the admin Queue tab's own gate is on.
- `reasons` are stable keys with **no counts inside** (one incident keeps one
  identity while it worsens or drains). The script diffs them against the
  previous poll and reads the current numbers from the body when it pages.
- Off → `404 { "error": "watchdog lane disabled" }`. That is a configuration
  state, not an outage: stop and tell the operator.

## Prerequisites (operator/Adam sets these; not the agent)

Portal (Railway):
- `GATE_CRON_JOBS=true` (global cron gate — already set). The reciprocal
  "watchdog silent" bell is a cron; with this off it never runs, and the
  snapshot reports `scheduler:disabled` on the first poll so you are told.
- `GATE_HERMES_WORKER=true` (shared worker-auth gate — already set).
- `GATE_HERMES_WATCHDOG=true` — this lane's switch. Unset = kill.
- `LINK_WORKER_SECRET_HERMES_WATCHDOG=<random 32+ bytes>` — the watchdog's OWN
  signing secret (never the backlink key).
- Optional `HERMES_WATCHDOG_STALE_MINUTES` (default 45): how long the portal
  waits before it bells "FIX: Hermes watchdog silent" — the reciprocal check.

Hermes box:
- The same secret at `/data/workspace/.waves-link-worker-secret-watchdog`
  (mode 0600). From `docs/hermes/` in the repo, copy `sign-request.py` into
  `/data/workspace/` **as `sign_request.py`** (underscore — it is imported as a
  module) and `watchdog_poll.py` alongside it. Standard library only; no pip.
- `PORTAL_URL` in the profile env (default in the script:
  `https://portal.wavespestcontrol.com`).
- Telegram gateway configured with `allowed users` = Adam's numeric ID only,
  pairing off, home chat = Adam's DM (Masterclass module 10, trust layer).
- Profile posture: approvals manual, website blocklist on, `allow_private_urls`
  off. The script needs no shell beyond `python3`.

## How to run (cron job, every 10 minutes)

Create a cron job on the `hermes-watchdog` profile:

- schedule `*/10 * * * *`
- prompt (this is the whole job — keep it verbatim):

  > Run `python3 /data/workspace/watchdog_poll.py`. If it prints anything,
  > send that text, unchanged, to the Telegram home chat. If it prints nothing,
  > do nothing and end the run without a message. Never call any other tool.
  > If the script exits 2, send its stderr line to the home chat once.

- delivery: Telegram home chat.

Once the Hermes version on the box is confirmed to skip delivery on empty
output, convert this to a **script-only (no-model) job** running the same
command with Telegram delivery — same behaviour, zero tokens. Until that is
verified, the prompt form above is the safe default: the script is still the
only thing deciding whether to page.

The script is idempotent and safe to re-run. State is
`/data/workspace/.waves-watchdog-state.json`; deleting it makes the next poll
treat every current reason as new (one catch-up page), nothing else.

## What a page looks like

Portal down (after 3 consecutive failed polls ≈ 30 min; repeats every 6 h while
down; one "reachable again" message on recovery):

> 🚨 Waves portal DOWN or degraded since 2026-09-03T13:40:00Z — unreachable
> (ConnectTimeout). 3 consecutive failed polls. Check Railway (portal service
> + Postgres) and https://portal.wavespestcontrol.com/api/health.

New attention reasons (only the NEW ones; cleared ones are not announced):

> ⚠️ Waves agents need attention (2 new):
> • geocoder-backstop is failing · last success 190 min ago · 3 failures in a row
> • ops queue lane calls: 2 failed row(s)
> https://portal.wavespestcontrol.com/admin/agents?tab=queue

Configuration, not an outage (HTTP 401 / 403 / 404, or 503 "worker key not
configured" — the lane gate off, the worker gate off, a wrong secret, or the
portal-side secret env missing). Once per 24 h, and it never advances the
outage streak:

> 🔧 Waves watchdog not configured: HTTP 404: the watchdog lane is off
> (GATE_HERMES_WATCHDOG unset) — flip the gate or pause this cron. Polls
> continue; nothing is down.

Healthy, or nothing changed: **no message**. Quiet is the normal state.

## Hard limits

- Read-only. No POST, no portal writes, no other portal routes.
- No customer lookups; the snapshot has no customer data by contract
  (`docs/public-route-contracts.md`).
- Never rewrite or "improve" the page text — the operator relies on the exact
  reason keys to correlate with the portal.
- Never change the cron cadence: the portal's liveness check expects a poll at
  least every 45 minutes.
