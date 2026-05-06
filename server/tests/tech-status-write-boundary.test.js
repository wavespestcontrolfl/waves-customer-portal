const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SCAN_DIRS = [
  'server/routes',
  'server/services',
];
const ALLOWED_WRITER = 'server/services/tech-status.js';

const DIRECT_WRITE_PATTERNS = [
  /INSERT\s+INTO\s+tech_status\b/i,
  /UPDATE\s+tech_status\b/i,
  /DELETE\s+FROM\s+tech_status\b/i,
  /TRUNCATE\s+TABLE\s+tech_status\b/i,
  /db\(\s*['"`]tech_status['"`]\s*\)[\s\S]{0,240}\.(?:insert|update|del|delete)\s*\(/i,
  /knex\(\s*['"`]tech_status['"`]\s*\)[\s\S]{0,240}\.(?:insert|update|del|delete)\s*\(/i,
  /trx\(\s*['"`]tech_status['"`]\s*\)[\s\S]{0,240}\.(?:insert|update|del|delete)\s*\(/i,
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (!entry.name.endsWith('.js')) return [];
    return [fullPath];
  });
}

describe('tech_status write boundary', () => {
  test('runtime code mutates tech_status only through services/tech-status.js', () => {
    const offenders = [];

    for (const relDir of SCAN_DIRS) {
      for (const filePath of walk(path.join(ROOT, relDir))) {
        const relPath = path.relative(ROOT, filePath);
        if (relPath === ALLOWED_WRITER) continue;

        const text = fs.readFileSync(filePath, 'utf8');
        for (const pattern of DIRECT_WRITE_PATTERNS) {
          if (pattern.test(text)) {
            offenders.push(relPath);
            break;
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
