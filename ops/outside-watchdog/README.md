# Outside watchdog (MacBook Air)

The portal cannot report its own death: when Railway, the database or the job
runner stops, the portal's own alert checks stop with it. The outside watchdog
watches from the office MacBook Air instead (always on AC, sleep off). It took
over from the Hostinger Hermes box, which last polled on 2026-09-05.

Every 10 minutes the launchd job `com.waves.portal-watchdog` runs `run.sh`,
which runs `deliver.js` under `railway run --service waves-customer-portal`.
`deliver.js` polls the portal once with the Hermes poll script
(`docs/hermes/watchdog_poll.py --json`, a signed GET of
`/api/integrations/watchdog-worker/status`) and delivers what it finds.

## What it reports

| Finding | When | Where it goes | Closes |
|---|---|---|---|
| Portal down or degraded | 3 failed polls in a row (about 30 min), or the database degraded | A row if the portal takes one, else an email to contact@ | When the portal answers again. An email alert gets a closing email. |
| Outage cause | The first good poll after a down alert | A row: "find why the portal was down" | By hand, when the cause is found |
| Job runner stopped | The scheduler heartbeat is over 60 min old, the cron gate is off, or the heartbeat read fails, on 2 good polls in a row | A row | On the first poll that no longer sees it |
| Watchdog setup | The portal refuses the poll (401, 403, 404, or 503 "worker key not configured") | A row | On the first good poll |

Rows are engineering FIX rows through `POST /api/ops/digest`: they land in
Agents → Activity, carry `who: claude` and `severity: broken`, and the Claude
fault launcher on the office Mac opens a tab for them. They never reach the
owner's bell. An email goes out only when the row cannot be written, through
`~/waves-ops/heartbeat/send-email.js` (internal inbox only). A write that fails
both ways is retried on the next run, for up to 48 hours.

The snapshot's other reasons (one failing job, an ops-queue lane, the link
worker) are not reported here. The portal's own checks report them, and the
job-runner finding covers the case where those checks cannot run.

## The reciprocal check

Each served poll writes a `seo_link_worker_requests` row (endpoint
`watchdog`, result `observed`). The portal's 23-minute cron
`hermes-watchdog-liveness` (`server/services/agent-watchdog-liveness.js`)
writes a Claude fault row "check the outside watchdog on the Air" when no poll
has arrived for 45 minutes (`HERMES_WATCHDOG_STALE_MINUTES`), and closes it on
the next poll. Both sides are dark unless `GATE_HERMES_WATCHDOG` and
`GATE_HERMES_WORKER` are on.

## Files on the Air (`~/waves-ops/portal-watchdog/`)

| File | What |
|---|---|
| `run.sh`, `deliver.js` | This folder |
| `watchdog_poll.py`, `sign_request.py` | `docs/hermes/watchdog_poll.py` and `docs/hermes/sign-request.py` (copied as `sign_request.py`, the name the poll imports) |
| `VERSION` | The commit they came from |
| `run.log` | One line per run; kept under about 1 MB |
| `poll-state.json` | The poll's failure count and last reasons |
| `deliver-state.json` | What is announced, and the outbox of owed writes |

No secret is stored there. The poll secret (`LINK_WORKER_SECRET_HERMES_WATCHDOG`),
the ingest token (`OPS_DIGEST_INGEST_TOKEN`) and the SMTP password come from the
portal's env through `railway run`, which uses the Railway login and the
project link of `~/waves-customer-portal` on the Air.

## Install or update

From a portal checkout on the office Mac:

```sh
zsh ops/outside-watchdog/install.sh            # the files at origin/main
zsh ops/outside-watchdog/install.sh <sha>      # or one commit
```

It copies the four files, writes `~/Library/LaunchAgents/com.waves.portal-watchdog.plist`
and reloads the job, which runs once at load. The state files are kept.

## Check it

```sh
ssh adams-air 'tail -5 ~/waves-ops/portal-watchdog/run.log'
ssh adams-air 'launchctl print gui/$(id -u)/com.waves.portal-watchdog | grep -E "state|last exit"'
```

A healthy line reads `poll=ok failures=0 runner=- wrote=- owed=0`. `owed=N`
counts writes that failed and wait for the next run; a `note=` names a local
error. `run.sh` adds `run.sh: exit N` after a failed run: 142 means the
240-second run limit, and an exit with no deliver line before it means
`railway run` itself failed. A "Not logged in" or "Unauthorized" line means the
Air's Railway login expired. Only the owner can sign in again:
`ssh -tt adams-air railway login --browserless`.

## Stop it

```sh
ssh adams-air 'launchctl bootout gui/$(id -u)/com.waves.portal-watchdog'
```

Then turn off `GATE_HERMES_WATCHDOG`, or the portal's reciprocal check reports
the silence after 45 minutes.

## Limits

- `railway run` needs Railway's API. In a Railway-wide outage it fails, so no
  poll runs and no email goes out. The portal itself is then down too.
- It depends on the Air's Railway login. When that login expires, polls stop,
  and the portal's reciprocal check reports it within about an hour.
- A 10-minute poll cannot see an outage shorter than about 20 minutes.
