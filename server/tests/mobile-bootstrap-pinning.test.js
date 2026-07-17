const fs = require('fs');
const path = require('path');

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
});
