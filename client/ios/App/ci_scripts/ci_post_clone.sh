#!/bin/bash
#
# ci_post_clone.sh — Xcode Cloud runs this after it clones the repository and
# before it opens the workspace.
#
# The native project is generated, not tracked (client/.gitignore): a clean
# clone has no App.xcworkspace, and a build stops with "Workspace
# App.xcworkspace does not exist at client/ios/App/App.xcworkspace". This
# script installs the tools the Xcode Cloud image lacks (Node, CocoaPods) and
# runs the same bootstrap a local build uses, so a cloud build and a local
# build come from one recipe.
#
# Xcode Cloud looks for this file in a ci_scripts folder beside the workspace,
# which is why this one folder inside client/ios is tracked.
#
# Workflow settings that go with it (App Store Connect → Xcode Cloud):
#   - Start condition: branch main.
#   - Environment variable WAVES_IOS_MARKETING_VERSION for a release other
#     than the default below.
#   - Settings → Build Number: set the next build number above the last
#     upload of that version (1.7 was uploaded as 2026100503).
set -euo pipefail

# The version this repository ships next. Raise it when App Review approves
# this one; App Store Connect refuses an upload to a closed version.
DEFAULT_MARKETING_VERSION="1.7"
# Waves Pest Control LLC. Public: the same id is in ios/WavesPay.
DEFAULT_TEAM_ID="BMNXJ4Q89M"

ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
cd "$ROOT"

export CI=true
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1

# Node comes from nodejs.org at the major version in .nvmrc, checked against
# the published SHA-256 list. Homebrew drops a node@N formula when that line
# reaches end of life, which would stop every cloud build.
NODE_MAJOR="$(tr -d 'v[:space:]' < .nvmrc | cut -d. -f1)"
if [ "${WAVES_CI_FORCE_NODE_INSTALL:-0}" = "1" ] || ! command -v node >/dev/null 2>&1 \
  || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  echo "==> Installing Node ${NODE_MAJOR} (.nvmrc)…"
  case "$(uname -m)" in arm64) NODE_ARCH="arm64" ;; *) NODE_ARCH="x64" ;; esac
  NODE_DIST="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  NODE_TMP="$(mktemp -d)"
  curl -fsSL --retry 3 "$NODE_DIST/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
  NODE_TAR="$(awk -v arch="darwin-${NODE_ARCH}.tar.gz" 'index($2, arch) { print $2; exit }' "$NODE_TMP/SHASUMS256.txt")"
  [ -n "$NODE_TAR" ] || { echo "ERROR: nodejs.org lists no darwin-${NODE_ARCH} build of Node ${NODE_MAJOR}." >&2; exit 1; }
  curl -fsSL --retry 3 "$NODE_DIST/$NODE_TAR" -o "$NODE_TMP/$NODE_TAR"
  (cd "$NODE_TMP" && grep " $NODE_TAR\$" SHASUMS256.txt | shasum -a 256 -c -)
  NODE_HOME="${WAVES_CI_NODE_HOME:-$HOME/.waves-node}"
  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xzf "$NODE_TMP/$NODE_TAR" -C "$NODE_HOME" --strip-components 1
  rm -rf "$NODE_TMP"
  PATH="$NODE_HOME/bin:$PATH"
  export PATH
fi
if ! command -v pod >/dev/null 2>&1; then
  echo "==> Installing CocoaPods…"
  brew install cocoapods
fi
node --version
pod --version

export WAVES_IOS_MARKETING_VERSION="${WAVES_IOS_MARKETING_VERSION:-$DEFAULT_MARKETING_VERSION}"
export WAVES_IOS_TEAM_ID="${WAVES_IOS_TEAM_ID:-$DEFAULT_TEAM_ID}"

bash scripts/mobile/bootstrap-ios.sh

test -d client/ios/App/App.xcworkspace || { echo "ERROR: bootstrap finished without client/ios/App/App.xcworkspace." >&2; exit 1; }
test -f client/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme || { echo "ERROR: no shared App scheme; Xcode Cloud cannot build." >&2; exit 1; }
echo "==> Xcode Cloud: workspace and shared App scheme are ready."
