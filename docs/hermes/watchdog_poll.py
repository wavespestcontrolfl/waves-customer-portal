#!/usr/bin/env python3
"""Waves agent watchdog — one poll of the portal health snapshot.

Runs on the Hostinger Hermes box from a cron job every 10 minutes (see
waves-agent-watchdog-skill.md). Standard library only (no requests). No model call: it signs one GET, diffs the
portal's `reasons` against the last poll, and prints a page ONLY when
something changed. Silence is the normal output.

    python3 watchdog_poll.py            # prints a page or nothing; exit 0

Exit code is always 0 on a completed poll (an unreachable portal is a
FINDING, not a script failure). Exit 2 only for a local misconfiguration
(signer module missing, secret file missing, non-http PORTAL_URL, unbuildable
request, unwritable state file) so the cron's own error path surfaces it. A page assembled before
a state-write failure is still printed first.

State lives in /data/workspace/.waves-watchdog-state.json:
  { "consecutive_failures": n, "last_reasons": [...], "last_paged_at": iso|null,
    "down_since": iso|null, "config_paged_at": iso|null }

Paging rules (deterministic — the portal computes the health, this only
decides whether it is NEWS):
  * HTTP 401 / 403 / 404, or 503 "worker key not configured" → CONFIGURATION, not an
    outage (the lane gate is off, the worker gate is off, or the key/secret is
    wrong). The portal answered, so the outage streak RESETS (a paged outage
    still gets its "reachable again" line) and the reason baseline is cleared
    (the next 200 re-announces everything still failing); one page per 24 h
    naming the fix.
  * unreachable / other non-200 / database.ok == false → failure streak += 1;
    page at exactly 3 consecutive (~30 min), then at most every 6 h while it
    stays down; one "back" page on recovery. The reason baseline is cleared
    (no snapshot was seen), so the recovery poll re-announces what still fails.
  * 200 + verdict=attention                         → page only for reason keys
    NOT in last_reasons. Cleared reasons are not announced (the admin bell
    and the Agents → Queue tab already show them).
  * 200 + verdict=healthy                            → nothing.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from sign_request import signed_headers, SECRET_FILES  # noqa: E402
except ImportError as _e:  # the rollout copies sign-request.py AS sign_request.py — a common miss
    print(f"watchdog_poll: sign_request.py not importable next to this script ({_e}); "
          "copy the portal's sign-request.py as sign_request.py", file=sys.stderr)
    sys.exit(2)

PORTAL_URL = os.environ.get("PORTAL_URL", "https://portal.wavespestcontrol.com").rstrip("/")
STATE_FILE = os.environ.get("WAVES_WATCHDOG_STATE", "/data/workspace/.waves-watchdog-state.json")
KEY_ID = "hermes_watchdog"
TIMEOUT_S = 15
PAGE_AFTER_FAILURES = 3
REPAGE_DOWN_HOURS = 6
REPAGE_CONFIG_HOURS = 24
# The portal answers these deliberately: 404 = GATE_HERMES_WATCHDOG off,
# 403 = GATE_HERMES_WORKER off or a key outside its capability, 401 = bad
# signature / secret. None of them means the portal is down.
CONFIG_STATUSES = {
    401: "the watchdog signature was rejected — check the secret file matches LINK_WORKER_SECRET_HERMES_WATCHDOG",
    403: "the worker integration is off (GATE_HERMES_WORKER) or this key lacks the watchdog capability",
    404: "the watchdog lane is off (GATE_HERMES_WATCHDOG unset) — flip the gate or pause this cron",
}
# 503 is ambiguous: the portal's own health probe answers 503 when its database
# is down (an outage), but link-worker-auth also answers 503 with this exact
# body when the portal-side secret env is missing (configuration).
KEY_UNCONFIGURED_BODY = "worker key not configured"
QUEUE_LINK = f"{PORTAL_URL}/admin/agents?tab=queue"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hours_since(iso):
    if not iso:
        return None
    then = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600.0


def load_state():
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
    except (OSError, ValueError):
        s = {}
    return {
        "consecutive_failures": int(s.get("consecutive_failures", 0) or 0),
        "last_reasons": list(s.get("last_reasons", []) or []),
        "last_paged_at": s.get("last_paged_at"),
        "down_since": s.get("down_since"),
        "config_paged_at": s.get("config_paged_at"),
    }


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def poll():
    """Return (state: "ok" | "down" | "config", snapshot|None, detail: str)."""
    url = f"{PORTAL_URL}/api/integrations/watchdog-worker/status"
    try:
        req = urllib.request.Request(url, headers={**signed_headers("GET", url, key_id=KEY_ID), "User-Agent": "Waves-Operations-Watchdog/1.0"}, method="GET")
    except (ValueError, OSError) as e:
        # A malformed PORTAL_URL or an unreadable secret is local
        # configuration (exit 2), never an outage finding.
        print(f"watchdog_poll: cannot build the request for {url!r}: {e}", file=sys.stderr)
        sys.exit(2)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        if e.code in CONFIG_STATUSES:
            return "config", None, f"HTTP {e.code}: {CONFIG_STATUSES[e.code]}"
        body = (e.read() or b"")[:120].decode("utf-8", "replace").replace("\n", " ")
        if e.code == 503 and KEY_UNCONFIGURED_BODY in body:
            return "config", None, "HTTP 503: LINK_WORKER_SECRET_HERMES_WATCHDOG is not set on the portal (Railway)"
        return "down", None, f"HTTP {e.code} {body}"
    except (urllib.error.URLError, OSError) as e:
        return "down", None, f"unreachable ({e.__class__.__name__})"
    if status != 200:
        return "down", None, f"HTTP {status}"
    try:
        snap = json.loads(raw.decode("utf-8"))
    except ValueError:
        return "down", None, "non-JSON response"
    # A proxy or half-deployed endpoint can answer 200 with `null` or a list;
    # that is a failed poll (advances the streak), never a script crash.
    if not isinstance(snap, dict) or not isinstance(snap.get("database"), dict):
        return "down", None, "malformed snapshot (not an object)"
    # The contract the diff relies on: a verdict word and a list of string
    # reason keys. Anything else is an incomplete response, not a recovery.
    reasons = snap.get("reasons")
    if snap.get("verdict") not in ("healthy", "attention") or not isinstance(reasons, list) \
            or not all(isinstance(r, str) for r in reasons):
        return "down", None, "malformed snapshot (missing verdict/reasons)"
    if not snap["database"].get("ok", False):
        return "down", snap, "database degraded"
    return "ok", snap, "ok"


def describe(reason, snap):
    kind = reason.split(":", 1)[0]
    if kind == "job":
        # Job names may themselves contain ':' (meta-capi-upload:qualified_lead);
        # the state is always the LAST segment.
        name, state = reason.split(":", 1)[1].rsplit(":", 1)
        for j in snap.get("jobs", {}).get("items", []):
            if j.get("job") == name:
                age = j.get("last_success_age_minutes")
                bits = [f"{name} is {state}"]
                if age is not None:
                    bits.append(f"last success {age} min ago")
                if j.get("consecutive_failures"):
                    bits.append(f"{j['consecutive_failures']} failures in a row")
                return " · ".join(bits)
        return f"{name} is {state}"
    if reason == "scheduler:disabled":
        return "portal crons are DISABLED (GATE_CRON_JOBS off) — nothing scheduled runs, including the portal's own reciprocal 'watchdog silent' bell"
    if reason == "scheduler:silent":
        s = snap.get("scheduler", {})
        age = s.get("age_minutes")
        when = f"{age} min ago" if age is not None else "never"
        return f"portal scheduler silent — heartbeat job last ticked {when} (limit {s.get('silent_after_minutes', '?')} min); crons are not running"
    if reason.endswith(":unavailable"):
        return f"{reason.split(':', 1)[0]} could not be read on the portal"
    if kind == "ops":
        parts = reason.split(":", 2)
        if len(parts) != 3:
            return reason
        _, lane, what = parts
        for l in snap.get("ops_queue", {}).get("lanes", []):
            if l.get("key") == lane:
                if what == "error":
                    return f"ops queue lane {lane} failed to load"
                return f"ops queue lane {lane}: {l.get('failed', '?')} failed row(s)"
        return f"ops queue lane {lane}: {what}"
    if reason == "link_worker:stale_leases":
        n = snap.get("link_worker", {}).get("stale_leases", "?")
        return f"backlink worker: {n} prospect lease(s) claimed over 2 h ago with no report"
    if reason == "db:degraded":
        return "database ping failed or timed out"
    return reason


def safe_describe(reason, snap):
    # One odd key must never abort the page — the raw key is always a valid line.
    try:
        return describe(reason, snap)
    except Exception:  # noqa: BLE001
        return reason


def main():
    if not os.path.exists(SECRET_FILES[KEY_ID]):
        print(f"watchdog_poll: secret file missing: {SECRET_FILES[KEY_ID]}", file=sys.stderr)
        sys.exit(2)
    if not PORTAL_URL.startswith(("https://", "http://")):
        print(f"watchdog_poll: PORTAL_URL is not an http(s) URL: {PORTAL_URL!r}", file=sys.stderr)
        sys.exit(2)

    state = load_state()
    result, snap, detail = poll()
    out = []

    if result == "config":
        # Deliberate portal state (kill switch, key scope, secret). The portal
        # answered, so any outage streak ends here — otherwise failures hours
        # apart would read as consecutive. Say so once a day.
        if state["consecutive_failures"] >= PAGE_AFTER_FAILURES and state["last_paged_at"]:
            # A paged outage that recovers into a configuration answer still
            # owes the "back" page, or the DOWN alert would stand forever.
            out.append(f"✅ Waves portal reachable again (down since {state['down_since']}) — now answering a configuration response.")
        state["consecutive_failures"] = 0
        state["down_since"] = None
        # No snapshots are observed while configured-off, so the reason
        # baseline is stale: drop it and let the first 200 catch up, or an
        # incident that recovered and re-failed meanwhile would be swallowed.
        state["last_reasons"] = []
        since = hours_since(state["config_paged_at"])
        if since is None or since >= REPAGE_CONFIG_HOURS:
            out.append(f"🔧 Waves watchdog not configured: {detail}. Polls continue; nothing is down.")
            state["config_paged_at"] = now_iso()
    elif result == "down":
        state["consecutive_failures"] += 1
        if not state["down_since"]:
            state["down_since"] = now_iso()
        # No snapshot was observed: the baseline is stale from here (same as
        # the configuration branch), so the recovery poll catches up.
        state["last_reasons"] = []
        n = state["consecutive_failures"]
        since_page = hours_since(state["last_paged_at"])
        if n == PAGE_AFTER_FAILURES or (n > PAGE_AFTER_FAILURES and (since_page is None or since_page >= REPAGE_DOWN_HOURS)):
            out.append(
                f"🚨 Waves portal DOWN or degraded since {state['down_since']} — {detail}. "
                f"{n} consecutive failed polls. Check Railway (portal service + Postgres) and {PORTAL_URL}/api/health."
            )
            state["last_paged_at"] = now_iso()
    else:
        state["config_paged_at"] = None
        if state["consecutive_failures"] >= PAGE_AFTER_FAILURES and state["last_paged_at"]:
            out.append(f"✅ Waves portal reachable again (down since {state['down_since']}).")
        state["consecutive_failures"] = 0
        state["down_since"] = None

        reasons = list(snap.get("reasons", []) or [])
        new = [r for r in reasons if r not in state["last_reasons"]]
        if snap.get("verdict") == "attention" and new:
            lines = [f"⚠️ Waves agents need attention ({len(new)} new):"]
            lines += [f"• {safe_describe(r, snap)}" for r in new]
            lines.append(QUEUE_LINK)
            out.append("\n".join(lines))
            state["last_paged_at"] = now_iso()
        state["last_reasons"] = reasons

    # Page FIRST: an assembled alert must reach the operator even when the
    # state file cannot be written. Then persist; an unwritable state path
    # (missing dir, full disk) is local configuration (exit 2, forwarded by
    # the cron) — without it every outage poll would restart at failure 1.
    if out:
        print("\n\n".join(out))
    try:
        save_state(state)
    except OSError as e:
        print(f"watchdog_poll: cannot write state file {STATE_FILE}: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
