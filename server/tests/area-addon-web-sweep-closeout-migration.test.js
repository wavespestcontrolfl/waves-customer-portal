/**
 * 20261008220000: the web sweep applies no product, so its closeout must not
 * wait for an application log or a customer notice (the pest_control family
 * infers both). The row gets explicit labor-only requirements on a
 * non-inferred source; the chemical add-ons keep the inferred ones.
 */
const migration = require('../models/migrations/20261008220000_area_addon_web_sweep_closeout');
const { normalizeRequirements } = require('../services/service-closeout-requirements');

const COLUMNS = ['requires_service_report', 'requires_application_log', 'required_photo_count',
  'requires_customer_signature', 'requires_customer_notice', 'closeout_requirements_source'];

function fakeKnex(rows, { columns = COLUMNS } = {}) {
  const knex = (table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    const tests = [];
    const q = {
      columnInfo: async () => Object.fromEntries(columns.map((c) => [c, {}])),
      where(cond) {
        if (typeof cond === 'function') {
          const alts = [];
          cond({
            whereNull(col) { alts.push((r) => r[col] === null || r[col] === undefined); return this; },
            orWhereIn(col, values) { alts.push((r) => values.includes(r[col])); return this; },
          });
          tests.push((r) => alts.some((alt) => alt(r)));
        } else tests.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      update: async (patch) => {
        const hits = rows.filter((r) => tests.every((t) => t(r)));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'now' };
  return knex;
}

const sweep = (extra = {}) => ({
  id: 'svc-web', service_key: 'area_addon_web_sweep', name: 'Web Sweep', category: 'pest_control',
  requires_service_report: true, requires_application_log: false, required_photo_count: 0,
  requires_customer_signature: false, requires_customer_notice: false, closeout_requirements_source: 'inferred_v1', ...extra,
});

describe('web sweep closeout requirements migration', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('before: the pest family infers an application log and a notice for the sweep', () => {
    expect(normalizeRequirements(sweep(), 'Web Sweep')).toMatchObject({ requiresApplicationLog: true, requiresCustomerNotice: true });
  });

  test('after: the sweep needs a service report only, read from an explicit source', async () => {
    const rows = [sweep()];
    await migration.up(fakeKnex(rows));
    expect(normalizeRequirements(rows[0], 'Web Sweep')).toMatchObject({
      requiresServiceReport: true,
      requiresApplicationLog: false,
      requiresCustomerNotice: false,
      requiredPhotoCount: 0,
      requiresCustomerSignature: false,
      source: migration.SOURCE_MARKER,
    });
  });

  test('a null source counts as inferred; an operator-edited row and other services are left alone', async () => {
    const rows = [
      sweep({ closeout_requirements_source: null }),
      { ...sweep({ id: 'svc-other', service_key: 'area_addon_fire_ant_yard', category: 'lawn_care' }) },
    ];
    await migration.up(fakeKnex(rows));
    expect(rows[0].closeout_requirements_source).toBe(migration.SOURCE_MARKER);
    expect(rows[1].closeout_requirements_source).toBe('inferred_v1');

    const edited = [sweep({ closeout_requirements_source: 'manual', requires_application_log: true })];
    await migration.up(fakeKnex(edited));
    expect(edited[0]).toMatchObject({ closeout_requirements_source: 'manual', requires_application_log: true });
  });

  test('down reverts only a row still carrying the marker; missing columns skip', async () => {
    const rows = [sweep()];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    await migration.down(knex);
    expect(rows[0].closeout_requirements_source).toBe('inferred_v1');

    const untouched = [sweep()];
    await migration.up(fakeKnex(untouched, { columns: ['requires_service_report'] }));
    expect(untouched[0].closeout_requirements_source).toBe('inferred_v1');
  });
});
