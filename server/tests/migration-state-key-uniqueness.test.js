const fs = require('fs');
const path = require('path');

// Migrations that keep a rollback ownership record derive its key from their
// own stamp — `migration.<stamp>.state` in system_settings, or the
// `migration:<stamp>` changed_by tag in pricing_config_audit. Stamps are NOT
// unique across files (parallel PRs land the same YYYYMMDD0000NN all the
// time), so two files deriving the same literal share one record: the later
// up() overwrites the earlier file's ownership map and the later down()
// deletes it, leaving the earlier down() nothing to restore (PR #3845: the
// flea cutover vs the sole-property anchor, both stamped 20260903000050).
// A file whose literal carries a different stamp than its own filename is the
// same defect one rename away (a stale key after moving the file).
const MIGRATIONS_DIR = path.join(__dirname, '..', 'models', 'migrations');
const DERIVED_KEY = /['"`](migration[.:](\d{14})(?:\.state)?)['"`]/g;

function derivedKeysByFile() {
  const byFile = new Map();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const keys = [...src.matchAll(DERIVED_KEY)].map(([, literal, stamp]) => ({ literal, stamp }));
    if (keys.length) byFile.set(file, keys);
  }
  return byFile;
}

describe('migration-derived state keys and audit tags', () => {
  const byFile = derivedKeysByFile();

  test('the scan sees the migrations that keep an ownership record', () => {
    expect(byFile.size).toBeGreaterThan(10);
  });

  test('every derived key carries the stamp of the file that owns it', () => {
    const stale = [];
    for (const [file, keys] of byFile) {
      const own = file.slice(0, 14);
      for (const { literal, stamp } of keys) if (stamp !== own) stale.push(`${file}: ${literal}`);
    }
    expect(stale).toEqual([]);
  });

  test('no two migration files derive the same key', () => {
    const owners = new Map();
    for (const [file, keys] of byFile) {
      for (const literal of new Set(keys.map((k) => k.literal))) {
        if (!owners.has(literal)) owners.set(literal, []);
        owners.get(literal).push(file);
      }
    }
    const shared = [...owners].filter(([, files]) => files.length > 1).map(([literal, files]) => `${literal}: ${files.join(', ')}`);
    expect(shared).toEqual([]);
  });
});
