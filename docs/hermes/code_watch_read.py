#!/usr/bin/env python3
"""READ-ONLY: bounded GitHub/Sentry evidence for Waves Code Watcher. No sends or writes."""
import json
import os
from pathlib import Path
import urllib.request
import urllib.error

def credential(name):
    value = os.environ.get(name)
    if value:
        return value
    path = Path("/data/profiles/waves-code/.env")
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == name:
                return value.strip()
    return None

def read_source(url, key):
    value = credential(key)
    if not value:
        return None, {"available": False, "reason": "credential_missing"}
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + value,
        "User-Agent": "Waves-Code-Watcher",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response), {"available": True}
    except urllib.error.HTTPError as error:
        return None, {"available": False, "reason": "http_error", "status": error.code}
    except (OSError, ValueError):
        return None, {"available": False, "reason": "source_unavailable"}

def collect():
    repo = "wavespestcontrolfl/waves-customer-portal"
    data, github = read_source("https://api.github.com/repos/" + repo + "/actions/runs?status=completed&per_page=30", "GITHUB_TOKEN")
    if github["available"]:
        if not isinstance(data, dict) or not isinstance(data.get("workflow_runs"), list):
            github = {"available": False, "reason": "invalid_response"}
        else:
            runs = data["workflow_runs"]
            github.update({"coverage": "latest_30_completed_runs", "truncated": data.get("total_count", 0) > len(runs), "items": [
                {"source_id": "github:" + repo + ":run:" + str(run["id"]),
                 "run_id": run["id"], "url": run.get("html_url"), "head_sha": run.get("head_sha"),
                 "branch": run.get("head_branch"), "conclusion": run.get("conclusion"),
                 "observed_updated_at": run.get("updated_at"), "run_attempt": run.get("run_attempt")}
                for run in runs if run.get("id") and run.get("conclusion") in ("failure", "timed_out", "action_required")
            ]})
    data, sentry = read_source("https://sentry.io/api/0/projects/4511171673849856/4511171681255425/issues/?query=is%3Aunresolved&statsPeriod=24h&sort=date&limit=25", "SENTRY_API_TOKEN")
    if sentry["available"]:
        if not isinstance(data, list):
            sentry = {"available": False, "reason": "invalid_response"}
        else:
            sentry.update({"coverage": "up_to_25_unresolved_issues_24h", "possibly_truncated": len(data) >= 25, "items": [
                {"source_id": "sentry:" + str(issue["id"]), "issue_id": issue["id"],
                 "url": issue.get("permalink"), "count": issue.get("count"),
                 "first_seen": issue.get("firstSeen"), "last_seen": issue.get("lastSeen"),
                 "status": issue.get("status")}
                for issue in data if issue.get("id")
            ]})
    return {"github": github, "sentry": sentry,
            "note": "Absence from these bounded windows does not establish resolution. Verify current source state before closing a case. Raw error messages and customer payloads are intentionally omitted."}

if __name__ == "__main__":
    print(json.dumps(collect()))

