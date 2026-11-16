#!/bin/zsh
# Install or update the outside watchdog on the MacBook Air from one commit of this repo.
# Run it on the office Mac, from a checkout of the portal:
#
#   zsh ops/outside-watchdog/install.sh [<git ref>]     # default: origin/main
#
# It copies the four run files at that commit to ~/waves-ops/portal-watchdog on the Air
# (sign-request.py goes as sign_request.py, the name the poll imports), writes the launchd
# job (every 10 min, and once at load) and loads it. The state files and run.log on the
# Air are kept, so an update does not reset an open alert. Runbook: README.md here.
set -eu

REF=${1:-origin/main}
HOST=${OUTSIDE_WATCHDOG_HOST:-adams-air}
LABEL=com.waves.portal-watchdog
SHA=$(git rev-parse --verify "${REF}^{commit}")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

git show "$SHA:docs/hermes/watchdog_poll.py" > "$STAGE/watchdog_poll.py"
git show "$SHA:docs/hermes/sign-request.py" > "$STAGE/sign_request.py"
git show "$SHA:ops/outside-watchdog/deliver.js" > "$STAGE/deliver.js"
git show "$SHA:ops/outside-watchdog/run.sh" > "$STAGE/run.sh"
print -r -- "$SHA" > "$STAGE/VERSION"

REMOTE_HOME=$(ssh "$HOST" 'printf %s "$HOME"')
DEST=$REMOTE_HOME/waves-ops/portal-watchdog
PLIST=$REMOTE_HOME/Library/LaunchAgents/$LABEL.plist

cat > "$STAGE/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$DEST/run.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$REMOTE_HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$DEST/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$DEST/launchd.log</string>
</dict>
</plist>
EOF
plutil -lint "$STAGE/$LABEL.plist" > /dev/null

ssh "$HOST" "mkdir -p '$DEST' '$REMOTE_HOME/Library/LaunchAgents'"
scp -q "$STAGE/watchdog_poll.py" "$STAGE/sign_request.py" "$STAGE/deliver.js" "$STAGE/run.sh" "$STAGE/VERSION" "$HOST:$DEST/"
scp -q "$STAGE/$LABEL.plist" "$HOST:$PLIST"
# Reload: bootout is asynchronous, so wait until the label is gone before bootstrap.
ssh "$HOST" "chmod 755 '$DEST/run.sh'
  domain=gui/\$(id -u)
  launchctl bootout \$domain/$LABEL 2>/dev/null || true
  n=0
  while launchctl print \$domain/$LABEL >/dev/null 2>&1 && [ \$n -lt 20 ]; do sleep 0.5; n=\$((n+1)); done
  launchctl bootstrap \$domain '$PLIST'
  launchctl print \$domain/$LABEL | grep -E '^[[:space:]]*(state|run interval|last exit code) ='"
print -r -- "installed $(git log -1 --format='%h %s' "$SHA") on $HOST:$DEST"
