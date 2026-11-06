#!/usr/bin/env python3
"""Sign a Waves link-worker request (plan §12 — per-provider HMAC).

Usage (from a Hermes skill; read the secret in Python, never in shell — the
dashboard's secret-redactor mangles secrets interpolated into shell commands):

    from sign_request import signed_headers
    import requests, json

    url = f"{PORTAL_URL}/api/integrations/backlink-worker/claim?type=outreach&n=5"
    r = requests.get(url, headers=signed_headers("GET", url))

    url2 = f"{PORTAL_URL}/api/integrations/backlink-worker/report"
    body = json.dumps(payload).encode()          # sign EXACTLY the bytes you send
    r = requests.post(url2, data=body,
                      headers={**signed_headers("POST", url2, body),
                               "Content-Type": "application/json"})

Contract (must match server/middleware/link-worker-auth.js):
  signature = HMAC-SHA256(secret,
      f"{timestamp}\n{nonce}\n{method}\n{canonical_target}\n{body_sha256}")
  canonical_target = path + "?" + query params sorted by key (percent-encoded);
  body_sha256 = sha256 of the RAW request bytes (empty-byte hash for GET).
Key ids: "hermes" (backlink claim/report) reads /data/workspace/.waves-link-worker-secret;
"hermes_vendor" (vendor price/login) reads /data/workspace/.waves-link-worker-secret-vendor;
"hermes_watchdog" (agent watchdog /status) reads /data/workspace/.waves-link-worker-secret-watchdog.
A key's secret comes from the portal's own env name instead (SECRET_ENV) when that is
set: a host that runs under `railway run --service waves-customer-portal`, like the
outside watchdog on the MacBook Air (ops/outside-watchdog/), keeps no copy on disk.
"""
import hashlib
import hmac
import os
import secrets
import time
from urllib.parse import urlsplit, parse_qsl, quote

SECRET_FILES = {
    "hermes": "/data/workspace/.waves-link-worker-secret",
    "hermes_vendor": "/data/workspace/.waves-link-worker-secret-vendor",
    "hermes_commitments": "/data/workspace/.waves-link-worker-secret-commitments",
    "hermes_watchdog": "/data/workspace/.waves-link-worker-secret-watchdog",
}
# The env names the portal reads for the same keys (KEY_RECORDS secretEnv in
# server/middleware/link-worker-auth.js; a test pins the two together).
SECRET_ENV = {
    "hermes": "LINK_WORKER_SECRET_HERMES",
    "hermes_vendor": "LINK_WORKER_SECRET_HERMES_VENDOR",
    "hermes_commitments": "LINK_WORKER_SECRET_HERMES_COMMITMENTS",
    "hermes_watchdog": "LINK_WORKER_SECRET_HERMES_WATCHDOG",
}


def _env_secret(key_id: str) -> str:
    return (os.environ.get(SECRET_ENV.get(key_id, "")) or "").strip()


def secret_available(key_id: str) -> bool:
    return bool(_env_secret(key_id)) or os.path.exists(SECRET_FILES[key_id])


def read_secret(key_id: str) -> str:
    env_value = _env_secret(key_id)
    if env_value:
        return env_value
    with open(SECRET_FILES[key_id]) as f:
        return f.read().strip()


def canonical_target(url: str) -> str:
    parts = urlsplit(url)
    pairs = sorted(
        (quote(k, safe=""), quote(v, safe=""))
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
    )
    query = "&".join(f"{k}={v}" for k, v in pairs)
    return parts.path + (f"?{query}" if query else "")


def signed_headers(method: str, url: str, body: bytes = b"", key_id: str = "hermes") -> dict:
    secret = read_secret(key_id)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body or b"").hexdigest()
    canonical = "\n".join(
        [timestamp, nonce, method.upper(), canonical_target(url), body_hash]
    )
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-waves-key-id": key_id,
        "x-waves-timestamp": timestamp,
        "x-waves-nonce": nonce,
        "x-waves-signature": signature,
    }


if __name__ == "__main__":
    import sys

    method, url = sys.argv[1], sys.argv[2]
    body = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
    for k, v in signed_headers(method, url, body, os.environ.get("WAVES_KEY_ID", "hermes")).items():
        print(f"{k}: {v}")
