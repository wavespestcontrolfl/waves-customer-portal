#!/usr/bin/env python3
"""Exercise project signing settings and real Mach-O entitlement inspection."""

import contextlib
import io
import json
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from ios_push import BUNDLE_ID, configure, verify


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "darwin", "Requires Xcode's plist and signing tools")
class IOSPushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="waves-ios-push-test-")
        self.addCleanup(self.temp.cleanup)
        self.project_dir = Path(self.temp.name)
        self.project_file = self.project_dir / "App.xcodeproj/project.pbxproj"
        self.project_file.parent.mkdir()
        template = ROOT / "node_modules/@capacitor/cli/assets/ios-pods-template.tar.gz"
        with tarfile.open(template) as archive:
            member = next(item for item in archive.getmembers() if item.name.endswith("project.pbxproj"))
            self.project_file.write_bytes(archive.extractfile(member).read())
        self.entitlement_file = self.project_dir / "App/App.entitlements"
        self.entitlement_file.parent.mkdir()
        self.entitlement_file.write_bytes(plistlib.dumps({
            "com.apple.developer.associated-domains": ["applinks:portal.wavespestcontrol.com"],
        }))

    def project(self):
        return json.loads(subprocess.check_output([
            "/usr/bin/plutil", "-convert", "json", "-o", "-", str(self.project_file),
        ]))

    def app_configs(self, project):
        objects = project["objects"]
        target = next(value for value in objects.values() if value.get("isa") == "PBXNativeTarget")
        return [objects[key] for key in objects[target["buildConfigurationList"]]["buildConfigurations"]]

    def test_fresh_project_signs_push_in_debug_and_release(self):
        configure(self.project_dir)
        entitlements = plistlib.loads(self.entitlement_file.read_bytes())
        self.assertEqual(entitlements["aps-environment"], "development")
        self.assertEqual(entitlements["com.apple.developer.associated-domains"], ["applinks:portal.wavespestcontrol.com"])
        # Ask Xcode for its effective settings, including the project plist
        # after serialization, instead of only re-reading our own Python data.
        for configuration in ("Debug", "Release"):
            settings = json.loads(subprocess.check_output([
                "xcodebuild", "-showBuildSettings", "-json", "-project", str(self.project_file.parent),
                "-target", "App", "-configuration", configuration, "-sdk", "iphoneos",
            ], stderr=subprocess.DEVNULL))
            self.assertEqual(settings[0]["buildSettings"]["CODE_SIGN_ENTITLEMENTS"], "App/App.entitlements")
        project = self.project()
        target_attributes = project["objects"][project["rootObject"]]["attributes"]["TargetAttributes"]
        self.assertTrue(any(value.get("SystemCapabilities", {}).get("com.apple.Push", {}).get("enabled") for value in target_attributes.values()))

    def test_existing_entitlement_paths_and_production_values_are_preserved(self):
        project = self.project()
        paths = []
        for config in self.app_configs(project):
            relative = f"App/{config['name']} Push.entitlements"
            path = self.project_dir / relative
            path.write_bytes(plistlib.dumps({"aps-environment": "production", "custom-capability": True}))
            config["buildSettings"]["CODE_SIGN_ENTITLEMENTS"] = f"$(SRCROOT)/{relative}"
            paths.append(path)
        self.project_file.write_bytes(plistlib.dumps(project))
        configure(self.project_dir)
        for path in paths:
            self.assertEqual(plistlib.loads(path.read_bytes()), {"aps-environment": "production", "custom-capability": True})
        self.assertEqual(
            [config["buildSettings"]["CODE_SIGN_ENTITLEMENTS"] for config in self.app_configs(self.project())],
            [config["buildSettings"]["CODE_SIGN_ENTITLEMENTS"] for config in self.app_configs(project)],
        )

    def test_capacitor_can_read_the_configured_project(self):
        configure(self.project_dir)
        version = subprocess.check_output([
            "node", "-e",
            "const {getMajoriOSVersion}=require('@capacitor/cli/dist/ios/common');"
            "process.stdout.write(getMajoriOSVersion({ios:{nativeXcodeProjDirAbs:process.argv[1]}}));",
            str(self.project_file.parent),
        ], cwd=ROOT, text=True)
        self.assertEqual(version, "14")

    def test_repeated_setup_is_idempotent(self):
        configure(self.project_dir)
        first = (self.project_file.read_bytes(), self.entitlement_file.read_bytes())
        configure(self.project_dir)
        self.assertEqual(first, (self.project_file.read_bytes(), self.entitlement_file.read_bytes()))

    def test_device_specific_signing_override_also_gets_push(self):
        project = self.project()
        device_file = self.project_dir / "App/Device.entitlements"
        device_file.write_bytes(plistlib.dumps({"custom-capability": True}))
        for config in self.app_configs(project):
            config["buildSettings"]["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"] = "App/Device.entitlements"
        self.project_file.write_bytes(plistlib.dumps(project))
        configure(self.project_dir)
        self.assertEqual(plistlib.loads(device_file.read_bytes()), {
            "custom-capability": True, "aps-environment": "development",
        })

    def test_invalid_entitlement_stops_without_rewriting_project(self):
        self.entitlement_file.write_bytes(plistlib.dumps({"aps-environment": "invalid"}))
        original = self.project_file.read_bytes()
        with self.assertRaisesRegex(ValueError, "invalid aps-environment"):
            configure(self.project_dir)
        self.assertEqual(self.project_file.read_bytes(), original)

    def signed_app(self, entitlements):
        app = self.project_dir / "Payload/Waves.app"
        app.mkdir(parents=True, exist_ok=True)
        # Sign a disposable Mach-O fixture. No Apple identity, device install,
        # production account, or live push token is used by these tests.
        shutil.copyfile("/usr/bin/true", app / "App")
        (app / "App").chmod(0o755)
        (app / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": BUNDLE_ID, "CFBundleExecutable": "App",
            "CFBundlePackageType": "APPL", "CFBundleSupportedPlatforms": ["iPhoneOS"],
        }))
        signing_file = self.project_dir / "signing.entitlements"
        signing_file.write_bytes(plistlib.dumps(entitlements))
        subprocess.run([
            "/usr/bin/codesign", "--force", "--sign", "-", "--entitlements", str(signing_file), str(app),
        ], capture_output=True, check=True)
        return app

    def test_signed_build_without_push_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "aps-environment=production"):
            verify(self.signed_app({}), "production")

    def test_development_push_cannot_pass_the_release_check(self):
        with self.assertRaisesRegex(ValueError, "aps-environment=production"):
            verify(self.signed_app({"aps-environment": "development"}), "production")

    def test_exported_ipa_with_production_push_passes(self):
        app = self.signed_app({"aps-environment": "production"})
        ipa = self.project_dir / "Waves.ipa"
        with zipfile.ZipFile(ipa, "w") as archive:
            for path in app.rglob("*"):
                archive.write(path, path.relative_to(self.project_dir))
        with contextlib.redirect_stdout(io.StringIO()) as result:
            verify(ipa, "production")
        self.assertIn("aps-environment=production", result.getvalue())

    def test_another_app_cannot_pass_the_customer_release_check(self):
        app = self.signed_app({"aps-environment": "production"})
        info = plistlib.loads((app / "Info.plist").read_bytes())
        info["CFBundleIdentifier"] = "com.example.other"
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, "customer app bundle identifier"):
            verify(app, "production")


if __name__ == "__main__":
    unittest.main()
