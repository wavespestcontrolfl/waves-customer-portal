/**
 * 20260924000030 mosquito misting completion posture — the follow-up flip
 * for Codex round-1 P1 on PR #4762. 20260924000020 was already pushed
 * (frozen, ran on the preview DB at f196b81130) with a generic
 * service_report/auto_send profile; this migration moves it to the
 * consultation posture (internal_only, no project_type) without editing
 * the frozen file.
 */
const migration = require('../models/migrations/20260924000030_mosquito_misting_completion_posture');

const SERVICE_KEY = 'mosquito_misting_system';
const STATE_KEY = 'migration.20260924000030.state';
const PRIOR_MARKER = '[mosquito_misting_catalog_action=inserted]';

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v));
    const q = {
      where(cond) { filters.push(cond); return q; },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: async (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(stored);
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async () => true,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

function emptyDb() {
  return { services: [], service_completion_profiles: [], system_settings: [] };
}

// The exact shape 20260924000020 (frozen) inserts.
const priorProfileRow = (over = {}) => ({
  service_key: SERVICE_KEY,
  service_name_snapshot: 'Mosquito Misting System Service',
  category: 'mosquito',
  billing_type: 'one_time',
  completion_mode: 'service_report',
  project_type: null,
  delivery_mode: 'auto_send',
  creates_service_record: true,
  portal_visibility: 'token_only',
  portal_attach_policy: 'recurring_customer',
  followup_policy: 'none',
  default_followup_days: null,
  active: true,
  notes: PRIOR_MARKER,
  ...over,
});

const serviceRow = (over = {}) => ({
  service_key: SERVICE_KEY,
  name: 'Mosquito Misting System Service',
  category: 'mosquito',
  billing_type: 'one_time',
  is_active: true,
  is_archived: false,
  ...over,
});

const profileRow = (db) => db.service_completion_profiles.find((r) => r.service_key === SERVICE_KEY);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260924000030 mosquito misting completion posture', () => {
  test('up() flips the exact 20260924000020 shape to the consultation posture', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow());

    await migration.up(fakeKnex(db));

    expect(profileRow(db)).toMatchObject({
      completion_mode: 'internal_only',
      project_type: null,
      delivery_mode: 'disabled',
      portal_visibility: 'internal_only',
      portal_attach_policy: 'never',
      // notes untouched by the flip — still 20260924000020's marker.
      notes: PRIOR_MARKER,
    });
    expect(stateValue(db)).toEqual({
      action: 'flipped',
      prior: {
        completion_mode: 'service_report',
        project_type: null,
        delivery_mode: 'auto_send',
        portal_visibility: 'token_only',
        portal_attach_policy: 'recurring_customer',
      },
    });
  });

  test('up() is idempotent — a second run on the now-consultation profile is a no-op', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow());

    await migration.up(fakeKnex(db));
    const afterFirst = { ...profileRow(db) };
    await migration.up(fakeKnex(db));

    expect(profileRow(db)).toEqual(afterFirst);
    expect(db.service_completion_profiles).toHaveLength(1);
  });

  test('up() leaves an admin-edited profile untouched (any field drift from the exact prior shape)', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    // Admin changed delivery_mode before this migration ran.
    db.service_completion_profiles.push(priorProfileRow({ delivery_mode: 'disabled' }));

    await migration.up(fakeKnex(db));

    expect(profileRow(db)).toMatchObject({ completion_mode: 'service_report', delivery_mode: 'disabled' });
    expect(stateValue(db)).toBeUndefined();
  });

  test('up() leaves a profile whose notes were admin-replaced untouched, even if every field matches', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow({ notes: 'Adam: reviewed, keeping as-is' }));

    await migration.up(fakeKnex(db));

    expect(profileRow(db)).toMatchObject({ completion_mode: 'service_report', notes: 'Adam: reviewed, keeping as-is' });
    expect(stateValue(db)).toBeUndefined();
  });

  test('up() inserts the consultation profile fresh when the services row exists but no profile does', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());

    await migration.up(fakeKnex(db));

    expect(profileRow(db)).toMatchObject({
      completion_mode: 'internal_only',
      project_type: null,
      delivery_mode: 'disabled',
      portal_visibility: 'internal_only',
      portal_attach_policy: 'never',
      active: true,
    });
    expect(stateValue(db)).toEqual({ action: 'inserted' });
  });

  test('up() is a no-op when the services row does not exist', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() restores the exact prior service_report/auto_send shape after a flip', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow());
    await migration.up(fakeKnex(db));

    await migration.down(fakeKnex(db));

    expect(profileRow(db)).toMatchObject({
      completion_mode: 'service_report',
      project_type: null,
      delivery_mode: 'auto_send',
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
    });
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() deletes the profile it inserted from nothing', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    await migration.up(fakeKnex(db));
    expect(profileRow(db)).toBeDefined();

    await migration.down(fakeKnex(db));

    expect(profileRow(db)).toBeUndefined();
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() leaves an admin-edited consultation profile untouched instead of clobbering it', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow());
    await migration.up(fakeKnex(db));
    // Admin further edits the (already-flipped) profile before rollback.
    profileRow(db).portal_attach_policy = 'recurring_customer';

    await migration.down(fakeKnex(db));

    // Restore skipped — the row no longer matches the consultation shape
    // this migration left it in.
    expect(profileRow(db)).toMatchObject({ completion_mode: 'internal_only', portal_attach_policy: 'recurring_customer' });
  });

  test('down() is a documented no-op when up() never changed anything (no state row)', async () => {
    const db = emptyDb();
    db.services.push(serviceRow());
    db.service_completion_profiles.push(priorProfileRow());
    await migration.down(fakeKnex(db));
    expect(profileRow(db)).toMatchObject({ completion_mode: 'service_report' });
  });
});
