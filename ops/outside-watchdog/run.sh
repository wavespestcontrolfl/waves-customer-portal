#!/bin/zsh
# Outside watchdog: one run on the MacBook Air (launchd com.waves.portal-watchdog, every
# 10 min; runbook: ops/outside-watchdog/README.md). It polls the portal from outside and
# delivers what it finds (deliver.js) under the portal's env, so no secret is kept on disk.
# It always exits 0: each run writes one line to run.log, and the portal's own silence
# check (server/services/agent-watchdog-liveness.js) reports a watchdog that stops polling.
DIR=${OUTSIDE_WATCHDOG_DIR:-$HOME/waves-ops/portal-watchdog}
# `railway run` reads the project link of this checkout (the Air's portal clone).
RAILWAY_DIR=${OUTSIDE_WATCHDOG_RAILWAY_DIR:-$HOME/waves-customer-portal}
RUNLOG=$DIR/run.log
# A run polls once (15 s HTTP limit) and makes at most a few writes (20 s each) or
# emails (60 s each); past this, the run is stuck and is killed.
RUN_LIMIT_S=240

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ }

# Keep run.log under about 1 MB: 6 lines an hour is about 0.5 MB a year.
if [[ -f $RUNLOG ]] && (( $(stat -f %z "$RUNLOG") > 1048576 )); then
  tail -n 3000 "$RUNLOG" > "$RUNLOG.tmp" && mv "$RUNLOG.tmp" "$RUNLOG"
fi

if ! cd "$RAILWAY_DIR" 2>/dev/null; then
  print -r -- "$(stamp) run.sh: cannot cd to $RAILWAY_DIR" >> "$RUNLOG"
  exit 0
fi

export OUTSIDE_WATCHDOG_DIR=$DIR
export OUTSIDE_WATCHDOG_PYTHON=/usr/bin/python3
# macOS has no `timeout`: perl sets an alarm and execs, so SIGALRM ends the run at the
# limit (no background reaper, no PID to reuse).
/usr/bin/perl -e 'alarm shift; exec @ARGV' "$RUN_LIMIT_S" \
  railway run --service waves-customer-portal -- node "$DIR/deliver.js" >> "$RUNLOG" 2>&1
rc=$?
# `railway run` turns every failed child exit into 1, so the deliver.js line above says
# which (owed=N, note=...). 142 = the run limit; with no deliver line, railway itself failed.
if (( rc != 0 )); then
  print -r -- "$(stamp) run.sh: exit $rc" >> "$RUNLOG"
fi
exit 0
