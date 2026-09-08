#!/usr/bin/env python3
"""Configure the customer app's APNs entitlement and inspect signed releases."""

import argparse
import json
import plistlib
import subprocess
import tempfile
import zipfile
from pathlib import Path


BUNDLE_ID = "com.wavespestcontrol.portal"


def configure(project_dir):
    project_dir = Path(project_dir).resolve()
    project_file = project_dir / "App.xcodeproj/project.pbxproj"
    project = json.loads(subprocess.check_output([
        "/usr/bin/plutil", "-convert", "json", "-o", "-", str(project_file),
    ]))
    original = json.dumps(project, sort_keys=True)
    objects = project["objects"]
    targets = [
        (key, value) for key, value in objects.items()
        if value.get("isa") == "PBXNativeTarget" and value.get("name") == "App"
        and value.get("productType") == "com.apple.product-type.application"
    ]
    if len(targets) != 1:
        raise ValueError("Expected exactly one App application target")
    target_id, target = targets[0]
    configurations = objects[target["buildConfigurationList"]]["buildConfigurations"]
    if not configurations:
        raise ValueError("App target has no build configurations")

    # Keep any existing entitlement files and unrelated capabilities. An older
    # generated project may have a different file for each configuration.
    entitlements = {}
    for config_id in configurations:
        settings = objects[config_id]["buildSettings"]
        signing_keys = ["CODE_SIGN_ENTITLEMENTS"] + [
            key for key in settings if key.startswith("CODE_SIGN_ENTITLEMENTS[")
        ]
        for key in signing_keys:
            # Device/SDK-specific overrides take precedence over the base
            # setting, so their files need the entitlement as well.
            configured_path = settings.get(key) or "App/App.entitlements"
            resolved_path = configured_path.replace("$(SRCROOT)", str(project_dir))
            resolved_path = resolved_path.replace("${SRCROOT}", str(project_dir))
            if "$" in resolved_path:
                raise ValueError("Resolve variables in App's CODE_SIGN_ENTITLEMENTS before setup")
            path = (project_dir / resolved_path).resolve()
            if not path.is_relative_to(project_dir):
                raise ValueError("App entitlement files must be inside the iOS project")
            value = plistlib.loads(path.read_bytes()) if path.exists() else {}
            if value.get("aps-environment") not in (None, "development", "production"):
                raise ValueError("App has an invalid aps-environment entitlement")
            # Distribution export uses the production provisioning profile.
            # Preserve an existing production value in the source file.
            value.setdefault("aps-environment", "development")
            entitlements[path] = value
            settings[key] = configured_path

    attributes = objects[project["rootObject"]].setdefault("attributes", {})
    target_attributes = attributes.setdefault("TargetAttributes", {}).setdefault(target_id, {})
    target_attributes.setdefault("SystemCapabilities", {})["com.apple.Push"] = {"enabled": 1}
    for path, value in entitlements.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps(value, sort_keys=False))
    if json.dumps(project, sort_keys=True) != original or not project_file.read_bytes().startswith(b"// !$*UTF8*$!"):
        # Capacitor also reads the OpenStep text directly. Use CocoaPods'
        # bundled xcodeproj writer to retain that format, staging the conversion
        # so a missing tool or failed conversion leaves the project intact.
        with tempfile.TemporaryDirectory(prefix="waves-ios-project-") as temp_dir:
            staged_project = Path(temp_dir) / "App.xcodeproj"
            staged_project.mkdir()
            staged_file = staged_project / "project.pbxproj"
            staged_file.write_bytes(plistlib.dumps(project, sort_keys=False))
            subprocess.run(["xcodeproj", "sort", str(staged_project)], capture_output=True, check=True)
            project_file.write_bytes(staged_file.read_bytes())
    print(f"APNs configured for all {len(configurations)} App build configurations")


def verify_app(app_path, environment):
    info = plistlib.loads((app_path / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise ValueError("Expected the Waves customer app bundle identifier")
    signed = subprocess.run([
        "/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", str(app_path),
    ], capture_output=True, check=True)
    entitlement = plistlib.loads(signed.stdout).get("aps-environment")
    if entitlement != environment:
        raise ValueError(f"Signed app must contain aps-environment={environment}; rebuild with Push Notifications enabled")
    print(f"Verified signed customer app: aps-environment={environment}")


def verify(path, environment):
    path = Path(path).resolve()
    if path.suffix == ".ipa":
        with tempfile.TemporaryDirectory(prefix="waves-ios-push-") as temp_dir:
            with zipfile.ZipFile(path) as archive:
                archive.extractall(temp_dir)
            apps = list((Path(temp_dir) / "Payload").glob("*.app"))
            if len(apps) != 1:
                raise ValueError("Expected one application in the IPA Payload")
            verify_app(apps[0], environment)
    else:
        verify_app(path, environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    configure_parser = commands.add_parser("configure")
    configure_parser.add_argument("project_dir")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("app_or_ipa")
    verify_parser.add_argument("--environment", choices=("development", "production"), default="production")
    args = parser.parse_args()
    try:
        if args.command == "configure":
            configure(args.project_dir)
        else:
            verify(args.app_or_ipa, args.environment)
    except (ValueError, OSError, subprocess.CalledProcessError, plistlib.InvalidFileException, zipfile.BadZipFile) as error:
        parser.exit(1, f"iOS push check failed: {error}\n")


if __name__ == "__main__":
    main()
