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

// The corrective termite changelog migration READS the prior seed's audit tag
// to copy its value into a new changelog row. It never owns or writes that tag.
// Keep this exception tied to the exact read-only use: another SEED_TAG use,
// including a later mutation, must be caught by the ownership scan.
function isReadOnlySeedAuditReference(file, src, literal, matchIndex) {
  const declaration = "const SEED_TAG = 'migration:20260911000020';";
  return file === '20260914000001_termite_annual_plan_changelog.js'
    && literal === 'migration:20260911000020'
    && matchIndex === src.indexOf(declaration) + 'const SEED_TAG = '.length
    && src.includes(declaration)
    && /\.where\(\{ config_key: KEY, changed_by: SEED_TAG \}\)\.whereNull\('old_value'\)\.first\(\)/.test(src)
    && [...src.matchAll(/\bSEED_TAG\b/g)].length === 2;
}

function derivedKeys(file, src) {
  return [...src.matchAll(DERIVED_KEY)]
    .filter((match) => !isReadOnlySeedAuditReference(file, src, match[1], match.index))
    .map(([, literal, stamp]) => ({ literal, stamp }));
}

function derivedKeysByFile() {
  const byFile = new Map();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const keys = derivedKeys(file, src);
    if (keys.length) byFile.set(file, keys);
  }
  return byFile;
}

describe('migration-derived state keys and audit tags', () => {
  const byFile = derivedKeysByFile();

  test('the scan sees the migrations that keep an ownership record', () => {
    expect(byFile.size).toBeGreaterThan(10);
  });

  test('the prior seed lookup is exempt only while it stays read-only', () => {
    const file = '20260914000001_termite_annual_plan_changelog.js';
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    expect(derivedKeys(file, src)).not.toContainEqual({ literal: 'migration:20260911000020', stamp: '20260911000020' });
    const mutatingSrc = src.replace('  const existing =',
      "  await knex('pricing_config_audit').insert({ changed_by: SEED_TAG });\n  const existing =");
    expect(derivedKeys(file, mutatingSrc)).toContainEqual({ literal: 'migration:20260911000020', stamp: '20260911000020' });
    const literalMutation = src.replace('  const existing =',
      "  await knex('pricing_config_audit').insert({ changed_by: 'migration:20260911000020' });\n  const existing =");
    expect(derivedKeys(file, literalMutation)).toContainEqual({ literal: 'migration:20260911000020', stamp: '20260911000020' });
  });

  test('every derived key carries the stamp of the file that owns it', () => {
    const stale = [];
    for (const [file, keys] of byFile) {
      const own = file.slice(0, 14);
      for (const { literal, stamp } of keys) if (stamp !== own) stale.push(`${file}: ${literal}`);
    }
    expect(stale).toEqual([]);
  });

  // One collision already LANDED before this guard could catch it: #4760 and
  // #4762 merged the same morning (2026-09-24), both stamped 20260924000020,
  // and both ran in production in the 11:19Z deploy. Neither file may be
  // renamed or edited now (knex tracks by filename; an edit is a no-op where
  // it already ran). The practical damage is bounded and already done: the
  // misting migration's recordState() union dropped the lawn file's {flipped}
  // list, whose only reader is that file's own idempotent re-run, and the
  // lawn file's down() is a documented no-op — so nothing is left to restore.
  // The exemption is EXACT: a third file on this key, or either file gone,
  // fails the test again.
  const LANDED_COLLISIONS = new Map([
    ['migration.20260924000020.state', ['20260924000020_bimonthly_lawn_service_not_offered.js', '20260924000020_mosquito_misting_catalog_row.js']],
  ]);

  test('the landed collision is still exactly the documented pair', () => {
    for (const [literal, files] of LANDED_COLLISIONS) {
      for (const file of files) {
        expect(byFile.get(file)?.map((k) => k.literal)).toContain(literal);
      }
    }
  });

  test('no two migration files derive the same key', () => {
    const owners = new Map();
    for (const [file, keys] of byFile) {
      for (const literal of new Set(keys.map((k) => k.literal))) {
        if (!owners.has(literal)) owners.set(literal, []);
        owners.get(literal).push(file);
      }
    }
    const shared = [...owners]
      .filter(([literal, files]) => files.length > 1 && JSON.stringify([...files].sort()) !== JSON.stringify(LANDED_COLLISIONS.get(literal) || null))
      .map(([literal, files]) => `${literal}: ${files.join(', ')}`);
    expect(shared).toEqual([]);
  });
});
