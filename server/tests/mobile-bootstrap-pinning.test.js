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
    // A missing Homebrew wrapper must not end the script under pipefail.
    expect(source).toMatch(/POD_GEM_HOME="\$\(.*\|\| true\)"/);
    // The manual add step prints only when the automatic attach failed.
    expect(source).toContain('if [ "${PRIVACY_ATTACHED:-0}" != "1" ]; then');
    // The floor is raised before `npx cap sync ios`, which runs pod install.
    expect(source.indexOf('IOS_MIN="15.0"')).toBeLessThan(source.indexOf('\nnpx cap sync ios'));
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
