#!/usr/bin/env bash
# One-shot bootstrap for the WavesPay Xcode project.
#
# What this does:
#   1. Ensures XcodeGen is installed (via Homebrew). If brew isn't available
#      we bail out with a readable error — Adam only runs this on his Mac.
#   2. Runs `xcodegen generate` which reads project.yml and produces
#      ios/WavesPay/WavesPay.xcodeproj + ios/WavesPay/Resources/Info.plist.
#   3. Resolves Swift packages so the first Xcode launch doesn't sit on
#      "Fetching Stripe Terminal iOS SDK" for 30 seconds.
#
# Re-run any time project.yml changes. Safe to run repeatedly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "▸ Bootstrapping WavesPay Xcode project in $SCRIPT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ This script only runs on macOS — iOS builds require Xcode." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "▸ XcodeGen not found — installing via Homebrew"
  if ! command -v brew >/dev/null 2>&1; then
    echo "✗ Homebrew not installed. Install it from https://brew.sh and re-run." >&2
    exit 1
  fi
  brew install xcodegen
fi

echo "▸ Running xcodegen generate"
xcodegen generate

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "⚠ xcodebuild not found — install Xcode from the Mac App Store, then open WavesPay.xcodeproj manually." >&2
  exit 0
fi

echo "▸ Resolving Swift Package dependencies (Stripe Terminal SDK)"
xcodebuild -resolvePackageDependencies \
  -project WavesPay.xcodeproj \
  -scheme WavesPay \
  >/dev/null || {
  echo "⚠ Package resolution failed — open WavesPay.xcodeproj and let Xcode resolve packages on first launch." >&2
}

echo ""
echo "✓ Done. Open WavesPay.xcodeproj in Xcode, pick your iPhone as the destination, and hit ⌘R."
