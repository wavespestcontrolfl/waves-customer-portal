const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SCAN_DIRS = [
  'client/src',
  'scripts',
  'server/middleware',
  'server/models',
  'server/routes',
  'server/scripts',
  'server/services',
  'server/sockets',
  'server/utils',
];
// Schema migrations legitimately reference retired tables (they created/dropped them).
const SKIP_DIR_NAMES = new Set(['migrations']);
const LEGACY_TABLES = ['dispatch_jobs', 'dispatch_technicians'];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) return [];
      return walk(fullPath);
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.jsx')) return [];
    return [fullPath];
  });
}

describe('legacy dispatch table guard', () => {
  test('runtime and tooling code do not reference retired dispatch tables', () => {
    const offenders = [];

    for (const relDir of SCAN_DIRS) {
      for (const filePath of walk(path.join(ROOT, relDir))) {
        const text = fs.readFileSync(filePath, 'utf8');
        for (const table of LEGACY_TABLES) {
          if (text.includes(table)) {
            offenders.push(`${path.relative(ROOT, filePath)} -> ${table}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
