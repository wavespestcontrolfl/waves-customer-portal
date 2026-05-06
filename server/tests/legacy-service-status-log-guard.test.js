const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SCAN_DIRS = [
  'client/src',
  'scripts',
  'server/routes',
  'server/services',
];
const LEGACY_TABLE = 'service_status_log';

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.jsx')) return [];
    return [fullPath];
  });
}

describe('legacy service status log guard', () => {
  test('runtime and tooling code do not reference retired service_status_log table', () => {
    const offenders = [];

    for (const relDir of SCAN_DIRS) {
      for (const filePath of walk(path.join(ROOT, relDir))) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (text.includes(LEGACY_TABLE)) {
          offenders.push(`${path.relative(ROOT, filePath)} -> ${LEGACY_TABLE}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
