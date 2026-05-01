/**
 * DB-backed tests for PR 1.4 — municipality_ordinances + 4-jurisdiction seed.
 *
 * Self-skips without DATABASE_URL.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('municipality_ordinances (PR 1.4)', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── Schema presence ───────────────────────────────────────────────────
  test('every column the plan engine will read exists', async () => {
    const cols = await knex('municipality_ordinances').columnInfo();
    const required = [
      'id',
      'jurisdiction_name', 'jurisdiction_type',
      'county', 'city', 'state',
      'restricted_start_month', 'restricted_start_day',
      'restricted_end_month', 'restricted_end_day',
      'restricted_nitrogen', 'restricted_phosphorus',
      'applies_to_turf', 'applies_to_landscape',
      'phosphorus_requires_soil_test',
      'slow_release_required_pct', 'annual_n_limit_per_1000',
      'source_url', 'source_name', 'source_checked_at',
      'effective_date', 'amended_date',
      'notes', 'active', 'created_at', 'updated_at',
    ];
    for (const c of required) {
      expect(cols).toHaveProperty(c);
    }
    // Provenance columns are NOT NULL — every row must be auditable.
    expect(cols.source_url.nullable).toBe(false);
    expect(cols.source_name.nullable).toBe(false);
    expect(cols.source_checked_at.nullable).toBe(false);
  });

  // ── Seed verification ────────────────────────────────────────────────
  test('all 4 SWFL jurisdictions are seeded and active', async () => {
    const rows = await knex('municipality_ordinances')
      .where({ active: true })
      .orderBy('jurisdiction_name');
    const names = rows.map((r) => r.jurisdiction_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Charlotte County',
        'Manatee County',
        'North Port',
        'Sarasota County',
      ])
    );
  });

  test('Sarasota County has Jun 1 – Sep 30 N/P window', async () => {
    const r = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Sarasota County', active: true })
      .first();
    expect(r.jurisdiction_type).toBe('county');
    expect(r.county).toBe('Sarasota');
    expect(r.restricted_start_month).toBe(6);
    expect(r.restricted_start_day).toBe(1);
    expect(r.restricted_end_month).toBe(9);
    expect(r.restricted_end_day).toBe(30);
    expect(r.restricted_nitrogen).toBe(true);
    expect(r.restricted_phosphorus).toBe(true);
    expect(r.phosphorus_requires_soil_test).toBe(true);
  });

  test('North Port has BROADER Apr 1 – Sep 30 window (city overlay)', async () => {
    // The plan engine layers city overlays on top of county rules
    // and applies the stricter combination. North Port's window is
    // BROADER than Sarasota County's — proves the data captures the
    // overlay correctly.
    const r = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'North Port', active: true })
      .first();
    expect(r.jurisdiction_type).toBe('city');
    expect(r.city).toBe('North Port');
    expect(r.county).toBe('Sarasota');
    expect(r.restricted_start_month).toBe(4); // April vs Sarasota's June
    expect(r.restricted_end_month).toBe(9);
    expect(r.restricted_end_day).toBe(30);
    expect(r.applies_to_landscape).toBe(false); // turf-only
  });

  test('Manatee County requires soil test for P year-round', async () => {
    const r = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Manatee County', active: true })
      .first();
    expect(r.phosphorus_requires_soil_test).toBe(true);
    expect(r.restricted_start_month).toBe(6);
    expect(r.restricted_end_month).toBe(9);
  });

  test('Charlotte County has no verified blackout window — office review', async () => {
    const r = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Charlotte County', active: true })
      .first();
    // Charlotte deliberately seeded WITHOUT an aggressive blackout
    // window because no county-level ordinance is verified. The plan
    // engine reads this state as "office review required for N/P".
    expect(r.restricted_start_month).toBeNull();
    expect(r.restricted_end_month).toBeNull();
    expect(r.restricted_nitrogen).toBe(false);
    expect(r.restricted_phosphorus).toBe(false);
    // FFL baseline still applies for slow-release + annual cap.
    expect(parseFloat(r.slow_release_required_pct)).toBe(50);
    expect(parseFloat(r.annual_n_limit_per_1000)).toBe(4);
    // Notes flag the office-review requirement so it's not silent.
    expect(r.notes).toMatch(/office review/i);
  });

  // ── Provenance ───────────────────────────────────────────────────────
  test('every active row carries source_url + source_name + source_checked_at', async () => {
    const rows = await knex('municipality_ordinances').where({ active: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source_url).toMatch(/^https?:\/\//);
      expect(r.source_name).toBeTruthy();
      expect(r.source_checked_at).toBeTruthy();
    }
  });

  // ── Uniqueness + history ─────────────────────────────────────────────
  test('partial unique index blocks two active rules for one jurisdiction', async () => {
    await expect(
      knex('municipality_ordinances').insert({
        jurisdiction_name: 'Sarasota County',
        jurisdiction_type: 'county',
        county: 'Sarasota',
        state: 'FL',
        source_url: 'https://example.invalid/dupe',
        source_name: 'Dup test',
        source_checked_at: new Date(),
        active: true,
      })
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // ── Provenance honesty (Codex P1 follow-up) ──────────────────────────
  test('source_checked_at is the actual verification date, not deploy time', async () => {
    // The seed hardcodes source_checked_at to 2026-04-30 (when the
    // sources were actually reviewed for this commit). Using
    // new Date() at migration runtime would falsely record the
    // deploy date and undermine the audit trail.
    const rows = await knex('municipality_ordinances').where({ active: true });
    for (const r of rows) {
      const checked = new Date(r.source_checked_at).toISOString().slice(0, 10);
      expect(checked).toBe('2026-04-30');
    }
  });

  // ── Per-jurisdiction idempotency (Codex P2 follow-up) ────────────────
  test('seed backfills missing jurisdictions even when others already exist', async () => {
    // Simulate a partially-seeded DB: drop one jurisdiction, re-run
    // the seed migration's logic, verify it gets restored.
    // (Down-then-up the migration to exercise the seed's idempotency
    // branch end-to-end.)
    const path = require('path');
    const migrationPath = path.join(__dirname, '..', 'models', 'migrations', '20260430000011_municipality_ordinances.js');
    const migration = require(migrationPath);

    // Soft-delete Charlotte's active row so it appears "missing" in
    // the partial unique index's space.
    await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Charlotte County', active: true })
      .update({ active: false });

    let charlotteAfterDelete = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Charlotte County', active: true })
      .first();
    expect(charlotteAfterDelete).toBeUndefined();

    // Re-run the seed step (the up() function — the createTable
    // step is guarded by hasTable so it'll be a no-op).
    await migration.up(knex);

    // Charlotte should be restored.
    const charlotteAfterReseed = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Charlotte County', active: true })
      .first();
    expect(charlotteAfterReseed).toBeTruthy();
    expect(charlotteAfterReseed.notes).toMatch(/office review/i);

    // The other 3 must NOT have been duplicated by the re-run.
    const sarasotaActive = await knex('municipality_ordinances')
      .where({ jurisdiction_name: 'Sarasota County', active: true });
    expect(sarasotaActive.length).toBe(1);
  });

  test('inactive history rows ARE allowed (rule supersession)', async () => {
    // Inserting an inactive row for the same jurisdiction must NOT
    // collide with the active one — supports rule history without
    // violating the partial unique index. Inserted then deleted
    // to keep the suite clean for the next run.
    const [{ id }] = await knex('municipality_ordinances').insert({
      jurisdiction_name: 'Sarasota County',
      jurisdiction_type: 'county',
      county: 'Sarasota',
      state: 'FL',
      source_url: 'https://example.invalid/historic',
      source_name: 'Historic test',
      source_checked_at: new Date(),
      active: false,
    }).returning('id');
    expect(id).toBeTruthy();
    await knex('municipality_ordinances').where({ id }).del();
  });
});
