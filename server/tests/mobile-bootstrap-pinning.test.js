const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');

describe('native customer-app bootstrap reproducibility', () => {
  for (const script of ['bootstrap-ios.sh', 'bootstrap-android.sh']) {
    test(`${script} installs from the committed lockfile`, () => {
      const source = fs.readFileSync(path.join(root, 'scripts/mobile', script), 'utf8');
      expect(source).toMatch(/^npm ci$/m);
      expect(source).not.toContain('@latest');
      expect(source).not.toMatch(/^npm install\b/m);
      expect(source).toContain('if [ "${CI:-}" = "true" ]');
    });
  }

  test('the iOS app lists the portal as its app-bound domain so the offline copy installs', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'client/capacitor.config.json'), 'utf8'));
    expect(config.ios.limitsNavigationsToAppBoundDomains).toBe(true);
    expect(new URL(config.server.url).hostname).toBe('portal.wavespestcontrol.com');
    const source = fs.readFileSync(path.join(root, 'scripts/mobile/bootstrap-ios.sh'), 'utf8');
    // The plist domain is derived from server.url, not typed a second time.
    expect(source).toContain('Add :WKAppBoundDomains array');
    expect(source).toContain('new URL(c.server.url).hostname');
    expect(source).not.toMatch(/WKAppBoundDomains:0 string portal\./);
  });

  test('bootstrap-ios raises the iOS floor to 15.0 and attaches the privacy manifest to the App target', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/mobile/bootstrap-ios.sh'), 'utf8');
    expect(source).toContain('IOS_MIN="15.0"');
    expect(source).toMatch(/platform :ios, '\$\{IOS_MIN\}'/);
    expect(source).toContain('IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN};');
    expect(source).toContain('phase.add_file_reference(ref, true) unless phase.files_references.include?(ref)');
    // Pods targets take their floor from podspecs: post_install raises them too.
    expect(source).toContain('waves: iOS floor');
    expect(source).toContain('installer.pods_project.targets.each');
    // A Podfile floor above 15 is kept, and a Podfile with no post_install gets one.
    expect(source).toContain("s/^platform :ios, '([0-9]|1[0-4])");
    expect(source).toContain('post_install do |installer|\\n" + hook + "end');
    // A missing Homebrew wrapper must not end the script under pipefail.
    expect(source).toMatch(/POD_GEM_HOME="\$\(.*\|\| true\)"/);
    // No GNU-only readlink -f as the first choice; CocoaPods' own Ruby runs the steps.
    expect(source).toContain('realpath "$POD_BIN"');
    expect(source).toContain('GEM_HOME="$POD_GEM_HOME" "$POD_RUBY" "$@"');
    // A gem-installed CocoaPods (no Homebrew GEM_HOME) still runs the xcodeproj steps.
    expect(source).not.toContain('if [ -n "$POD_GEM_HOME" ] && (cd ios/App');
    // The manual add step prints only when the automatic attach failed.
    expect(source).toContain('if [ "${PRIVACY_ATTACHED:-0}" != "1" ]; then');
    // The floor is raised before `npx cap sync ios`, which runs pod install.
    expect(source.indexOf('IOS_MIN="15.0"')).toBeLessThan(source.indexOf('\nnpx cap sync ios'));
  });

  test('bootstrap-ios adopts the UIScene life cycle that iOS 27 SDK builds require', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/mobile/bootstrap-ios.sh'), 'utf8');
    expect(source).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
    expect(source).toContain('ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url');
    expect(source).toContain('$(PRODUCT_MODULE_NAME).SceneDelegate');
    expect(source).toContain('UISceneStoryboardFile string Main');
    // A push tapped while the app was closed reaches Capacitor's push handler.
    expect(source).toContain('connectionOptions.notificationResponse');
    expect(source).toContain('router.userNotificationCenter(center, didReceive: response');
    // The tap is kept until the handler exists: no attempt limit.
    expect(source).toContain('private var pendingNotificationResponse: UNNotificationResponse?');
    expect(source).not.toContain('attemptsLeft');
    // CocoaPods' embed-frameworks script cannot run inside Xcode's user-script sandbox.
    expect(source).toContain('s/ENABLE_USER_SCRIPT_SANDBOXING = YES;/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g');
    // The manifest is written only after the delegate is in the target.
    expect(source.indexOf('target.source_build_phase')).toBeLessThan(source.indexOf('Add $SCENE_KEY dict'));
  });

  test('Xcode Cloud can generate the ignored iOS project from a clean clone', () => {
    const postClone = path.join(root, 'client/ios/App/ci_scripts/ci_post_clone.sh');
    // Xcode Cloud runs ci_scripts/ci_post_clone.sh from beside the workspace, and only if it is executable.
    expect(fs.statSync(postClone).mode & 0o111).not.toBe(0);
    const ci = fs.readFileSync(postClone, 'utf8');
    expect(ci).toContain('bash scripts/mobile/bootstrap-ios.sh');
    expect(ci).toMatch(/^export CI=true$/m);
    // Node follows .nvmrc and is checked against the published checksums.
    expect(ci).toContain('< .nvmrc');
    expect(ci).toContain('shasum -a 256 -c -');
    // That folder is the only tracked path inside the generated project.
    const tracked = spawnSync('git', ['ls-files', 'client/ios'], { cwd: root, encoding: 'utf8' });
    expect(tracked.stdout.trim().split('\n')).toEqual(['client/ios/App/ci_scripts/ci_post_clone.sh']);
    const ignored = spawnSync('git', ['check-ignore', '-q', 'client/ios/App/App.xcodeproj/project.pbxproj'], { cwd: root });
    expect(ignored.status).toBe(0);

    const source = fs.readFileSync(path.join(root, 'scripts/mobile/bootstrap-ios.sh'), 'utf8');
    // A clean clone has client/ios/App (the tracked folder) but no project: the add still runs.
    expect(source).toContain('if [ ! -d "ios/App/App.xcodeproj" ]; then');
    expect(source).not.toContain('if [ ! -d "ios/App" ]; then');
    // The tracked folder is moved aside for `cap add` and put back on every exit.
    expect(source).toContain('trap restore_ci_scripts EXIT');
    expect(source.indexOf('hold_ci_scripts\n  # Only empty folders')).toBeLessThan(source.indexOf('npx cap add ios'));
    // Xcode Cloud builds only a shared scheme; version and team are written only when named.
    expect(source).toContain('scheme.save_as(project.path, "App", true)');
    expect(source).toContain('c.build_settings["MARKETING_VERSION"] = version unless version.empty?');
    expect(source).toContain('c.build_settings["DEVELOPMENT_TEAM"] = team unless team.empty?');
  });

  test('bootstrap-ios installs the tracked icon into a clean catalog repeatably', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-ios-assets-'));
    const assetCatalog = path.join(fixture, 'Assets.xcassets');
    const iconSet = path.join(assetCatalog, 'AppIcon.appiconset');
    const splashSet = path.join(assetCatalog, 'Splash.imageset');
    const iconSource = path.join(root, 'client/resources/icon.png');
    const iconDest = path.join(iconSet, 'AppIcon-512@2x.png');
    const splashDest = path.join(splashSet, 'splash-2732x2732.png');
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const expectedCatalog = {
      images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'xcode', version: 1 },
    };
    try {
      fs.mkdirSync(iconSet, { recursive: true });
      fs.mkdirSync(splashSet, { recursive: true });
      fs.writeFileSync(splashDest, 'capacitor splash');
      const run = () => spawnSync('bash', [path.join(root, 'scripts/mobile/bootstrap-ios.sh'), '--assets-only'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, WAVES_IOS_ASSET_ROOT: assetCatalog },
      });

      const sourcePng = fs.readFileSync(iconSource);
      expect([sourcePng.readUInt32BE(16), sourcePng.readUInt32BE(20)]).toEqual([1024, 1024]);
      const sourceHash = hash(iconSource);
      let result = run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Waves app icon installed into AppIcon.appiconset');
      expect(hash(iconDest)).toBe(sourceHash);
      expect(JSON.parse(fs.readFileSync(path.join(iconSet, 'Contents.json'), 'utf8'))).toEqual(expectedCatalog);

      fs.writeFileSync(iconDest, 'stale icon');
      fs.writeFileSync(path.join(iconSet, 'Contents.json'), '{}');
      result = run();
      expect(result.status).toBe(0);
      expect(hash(iconDest)).toBe(sourceHash);
      expect(JSON.parse(fs.readFileSync(path.join(iconSet, 'Contents.json'), 'utf8'))).toEqual(expectedCatalog);
      expect(fs.readFileSync(splashDest)).toEqual(fs.readFileSync(path.join(root, 'client/resources/splash-2732x2732.png')));

      fs.rmSync(iconSet, { recursive: true });
      result = run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('icon source or app-icon set missing');
      expect(hash(iconSource)).toBe(sourceHash);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
