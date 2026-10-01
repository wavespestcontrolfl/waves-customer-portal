const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const ARCHIVE_FILE = '20260924000098_archive_shared_000020_state.js';
const HISTORICAL_COLLISION = Object.freeze({
  literal: 'migration.20260924000020.state',
  owners: Object.freeze({
    '20260924000020_bimonthly_lawn_service_not_offered.js': '08c8b103c6bd95e33d771de5320f7b20a7a75fd5f6389bbec41112c905c9e2e3',
    '20260924000020_mosquito_misting_catalog_row.js': 'c21207ac6cbf54f66cabfda75117a85dfae9f74de6065a9c6a71a540e9cc7bdf',
  }),
  archiveKey: 'migration.20260924000098.state',
});

function migrationSource(file) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function archiveContractForSource(src) {
  return src.includes(`const LEGACY_STATE_KEY = '${HISTORICAL_COLLISION.literal}';`)
    && src.includes(`const STATE_KEY = '${HISTORICAL_COLLISION.archiveKey}';`)
    && Object.entries(HISTORICAL_COLLISION.owners)
      .every(([file, hash]) => src.includes(`file: '${file}'`) && src.includes(`sha256: '${hash}'`))
    && src.includes("where({ key: LEGACY_STATE_KEY }).first('value')")
    && !/where\(\{ key: LEGACY_STATE_KEY \}\)\.(?:update|del)\(/.test(src)
    && /exports\.down = async function down\(\) \{\s*\/\/ Documented no-op:[^\n]*\n\s*\};/.test(src);
}

function hasArchiveContract(readSource = migrationSource) {
  return archiveContractForSource(readSource(ARCHIVE_FILE));
}

function isContainedHistoricalCollision(literal, files, readSource = migrationSource) {
  const expected = Object.keys(HISTORICAL_COLLISION.owners).sort();
  const actual = [...files].sort();
  if (literal !== HISTORICAL_COLLISION.literal
    || actual.length !== expected.length
    || actual.some((file, index) => file !== expected[index])
    || !hasArchiveContract(readSource)) return false;
  return expected.every((file) => sha256(readSource(file)) === HISTORICAL_COLLISION.owners[file]);
}

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

// The containment migration reads the frozen shared key as opaque text and
// writes only its own uniquely stamped archive key. Keep the exemption pinned
// to that exact declaration and the full archive contract so a mutation of the
// legacy row becomes an owner and fails the stale/duplicate scans.
function isReadOnlyCollisionArchiveReference(file, src, literal, matchIndex) {
  const declaration = `const LEGACY_STATE_KEY = '${HISTORICAL_COLLISION.literal}';`;
  return file === ARCHIVE_FILE
    && literal === HISTORICAL_COLLISION.literal
    && matchIndex === src.indexOf(declaration) + 'const LEGACY_STATE_KEY = '.length
    && [...src.matchAll(/\bLEGACY_STATE_KEY\b/g)].length === 5
    && archiveContractForSource(src);
}

// Pushed (frozen) migrations that only READ another migration's tag and own no
// system_settings state or pricing_config_audit row for it. Each exemption is
// pinned to the file's exact content and to the declaration of the foreign tag.
//  - 20260930010000 back-fills the audit_log publish events of two earlier
//    signup migrations: it reads the template versions each one tagged
//    (validation_snapshot.source) and writes a `<tag>:publish` audit_log
//    action, skipped if already present.
//  - 20260930100100 compares a template's active version source with the
//    first billing-details migration's tag to leave that version alone.
const PINNED_FOREIGN_TAG_READS = Object.freeze([
  Object.freeze({
    file: '20260930010000_signup_email_template_names_and_audit.js',
    sha256: '98b7baceabe5956e31093215390d7cc5b583f203be8b084f75558beb75b6659c',
    declarations: Object.freeze({
      'migration:20260929220000': "const STREAMS = 'migration:20260929220000';",
      'migration:20260930000000': "const DROP_PAYMENT = 'migration:20260930000000';",
    }),
  }),
  Object.freeze({
    file: '20260930100100_billing_email_detail_rows_fill_missing.js',
    sha256: 'e5496ae22e4bf87f4390d6476d1ede4a167ecd26ef47c58065f3d6799aea5eb5',
    declarations: Object.freeze({
      'migration:20260930090000': "const FIRST_MARKER = 'migration:20260930090000';",
    }),
  }),
]);

function isPinnedForeignTagRead(file, src, literal, matchIndex) {
  const pin = PINNED_FOREIGN_TAG_READS.find((p) => p.file === file);
  const declaration = pin?.declarations[literal];
  return Boolean(declaration)
    && sha256(src) === pin.sha256
    && matchIndex === src.indexOf(declaration) + declaration.indexOf("'");
}

function derivedKeys(file, src) {
  return [...src.matchAll(DERIVED_KEY)]
    .filter((match) => !isReadOnlySeedAuditReference(file, src, match[1], match.index)
      && !isReadOnlyCollisionArchiveReference(file, src, match[1], match.index)
      && !isPinnedForeignTagRead(file, src, match[1], match.index))
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

  test.each(PINNED_FOREIGN_TAG_READS.map((pin) => [pin.file, pin]))(
    'the pinned foreign-tag read in %s is exempt only while its content is unchanged', (file, pin) => {
      const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const own = file.slice(0, 14);
      const foreign = (keys) => keys.filter((k) => k.stamp !== own);
      expect(foreign(derivedKeys(file, src))).toEqual([]);
      const [tag] = Object.keys(pin.declarations);
      const edited = src.replace('exports.up = async function up(knex) {',
        `exports.up = async function up(knex) {\n  await knex('system_settings').insert({ key: '${tag}' });`);
      expect(edited).not.toBe(src);
      expect(foreign(derivedKeys(file, edited))).toContainEqual({ literal: tag, stamp: tag.slice(-14) });
      expect(foreign(derivedKeys('20261001000000_copy.js', src))).toHaveLength(Object.keys(pin.declarations).length);
    },
  );

  test('every derived key carries the stamp of the file that owns it', () => {
    const stale = [];
    for (const [file, keys] of byFile) {
      const own = file.slice(0, 14);
      for (const { literal, stamp } of keys) if (stamp !== own) stale.push(`${file}: ${literal}`);
    }
    expect(stale).toEqual([]);
  });

  test('the applied 000020 collision exception is hash-pinned, exactly two-owner, and archive-conditioned', () => {
    const owners = Object.keys(HISTORICAL_COLLISION.owners);
    expect(isContainedHistoricalCollision(HISTORICAL_COLLISION.literal, owners)).toBe(true);
    expect(isContainedHistoricalCollision(HISTORICAL_COLLISION.literal, [...owners, 'third_owner.js'])).toBe(false);
    expect(isContainedHistoricalCollision('migration.20260924000021.state', owners)).toBe(false);

    const changedOwner = owners[0];
    const readChangedSource = (file) => `${migrationSource(file)}${file === changedOwner ? '\n// changed' : ''}`;
    expect(isContainedHistoricalCollision(HISTORICAL_COLLISION.literal, owners, readChangedSource)).toBe(false);

    const mutatingArchive = migrationSource(ARCHIVE_FILE).replace(
      '  const legacy =',
      "  await knex('system_settings').where({ key: LEGACY_STATE_KEY }).del();\n  const legacy ="
    );
    expect(derivedKeys(ARCHIVE_FILE, mutatingArchive)).toContainEqual({
      literal: HISTORICAL_COLLISION.literal,
      stamp: '20260924000020',
    });
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
      .filter(([literal, files]) => files.length > 1 && !isContainedHistoricalCollision(literal, files))
      .map(([literal, files]) => `${literal}: ${files.join(', ')}`);
    expect(shared).toEqual([]);
  });
});
