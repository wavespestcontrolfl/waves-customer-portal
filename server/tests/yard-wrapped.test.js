/**
 * Yard Wrapped builder (server/services/yard-wrapped.js): the Dec 1 - Jan 31 ET
 * window and member check (no database read), the performed-visit count and the
 * split by service line, the 3-visit floor, the lawn score only with two or more
 * confirmed assessments, treatedFor screened and capped at 5, the top
 * technician's first name, and one failed read dropping only its field.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/photos', () => ({
  CUSTOMER_DWELL_TTL_SECONDS: 86400,
  getViewUrl: jest.fn(async (key) => `https://signed.example/${key}?sig=1`),
}));

const { yardWrappedYearFor, buildYardWrapped, _test } = require('../services/yard-wrapped');
const { WAVES_BUSINESS_NAME } = require('../constants/business');

// A fake knex: every builder method returns the builder, awaiting it yields the
// table's rows (or throws the table's error); `reads` records which tables were read.
function fakeDb({ tables = {}, failing = {} } = {}) {
  const reads = [];
  const database = (table) => {
    reads.push(table);
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => (failing[table] ? reject(new Error(`${table} down`)) : resolve(tables[table] || []));
        }
        return () => builder;
      },
    });
    return builder;
  };
  database.raw = (sql) => sql;
  database.reads = reads;
  return database;
}

const record = (day, extra = {}) => ({
  id: `rec-${day}-${extra.service_type || 'Pest Control'}`,
  day,
  service_type: 'Quarterly Pest Control',
  service_line: null,
  structured_notes: {},
  technician_id: 't1',
  technician_name: 'Jordan Reyes',
  ...extra,
});
const MEMBER = { id: 'c1', active: true, waveguard_tier: 'Silver' };
const WITH_GATE = (fn) => {
  const before = process.env.GATE_YARD_WRAPPED;
  process.env.GATE_YARD_WRAPPED = 'true';
  try { return fn(); } finally { if (before === undefined) delete process.env.GATE_YARD_WRAPPED; else process.env.GATE_YARD_WRAPPED = before; }
};

describe('yardWrappedYearFor', () => {
  test('gate off (unset, or anything but exactly true) answers null', () => {
    const before = process.env.GATE_YARD_WRAPPED;
    try {
      delete process.env.GATE_YARD_WRAPPED;
      expect(yardWrappedYearFor({ customer: MEMBER, now: new Date('2026-12-10T17:00:00Z') })).toBeNull();
      process.env.GATE_YARD_WRAPPED = 'TRUE';
      expect(yardWrappedYearFor({ customer: MEMBER, now: new Date('2026-12-10T17:00:00Z') })).toBeNull();
    } finally { if (before === undefined) delete process.env.GATE_YARD_WRAPPED; else process.env.GATE_YARD_WRAPPED = before; }
  });

  test('December shows its own year, January the year just ended, ET edges included', () => {
    WITH_GATE(() => {
      const at = (iso) => yardWrappedYearFor({ customer: MEMBER, now: new Date(iso) });
      expect(at('2026-11-30T23:00:00-05:00')).toBeNull();
      expect(at('2026-12-01T00:00:00-05:00')).toBe(2026);
      expect(at('2026-12-31T23:30:00-05:00')).toBe(2026);
      // 2027-01-01 03:00 UTC is still Dec 31 in ET; 2027-01-01 05:00 UTC is Jan 1.
      expect(at('2027-01-01T03:00:00Z')).toBe(2026);
      expect(at('2027-01-01T05:00:00Z')).toBe(2026);
      expect(at('2027-01-31T23:30:00-05:00')).toBe(2026);
      // Feb 1 00:00 ET = 05:00 UTC.
      expect(at('2027-02-01T05:00:00Z')).toBeNull();
      expect(at('2026-07-15T16:00:00Z')).toBeNull();
    });
  });

  test('only an active WaveGuard member qualifies', () => {
    WITH_GATE(() => {
      const now = new Date('2026-12-10T17:00:00Z');
      expect(yardWrappedYearFor({ customer: { ...MEMBER, active: false }, now })).toBeNull();
      expect(yardWrappedYearFor({ customer: { ...MEMBER, waveguard_tier: 'One-Time' }, now })).toBeNull();
      expect(yardWrappedYearFor({ customer: { id: 'c1', active: true, waveguard_tier: null, monthly_rate: 0 }, now })).toBeNull();
      expect(yardWrappedYearFor({ customer: { id: 'c1', active: true, waveguard_tier: null, monthly_rate: 89 }, now })).toBe(2026);
      expect(yardWrappedYearFor({ now })).toBeNull();
    });
  });
});

describe('performedRecord', () => {
  test('closeouts that perform nothing are not visits; a backfill closeout (late, quiet closeout of real work) is', () => {
    const p = (notes) => _test.performedRecord({ structured_notes: notes });
    expect(p({})).toBe(true);
    expect(p({ visitOutcome: 'completed' })).toBe(true);
    expect(p(JSON.stringify({ visitOutcome: 'customer_declined' }))).toBe(false);
    expect(p({ visitOutcome: 'inspection_only' })).toBe(false);
    expect(p({ visitOutcome: 'incomplete' })).toBe(false);
    expect(p({ backfill: true })).toBe(true);
    expect(p(null)).toBe(true);
  });
});

describe('buildYardWrapped', () => {
  const days = ['2026-02-03', '2026-04-07', '2026-06-09', '2026-08-11'];
  const baseTables = () => ({
    service_records: [
      ...days.map((d) => record(d)),
      record('2026-04-07', { id: 'rec-lawn', service_type: 'Lawn Care Visit', service_line: 'lawn' }),
      record('2026-06-09', { id: 'rec-lawn2', service_type: 'Lawn Care Visit', service_line: 'lawn' }),
      record('2026-09-01', { id: 'rec-mosq', service_type: 'Mosquito Control', technician_id: 't2', technician_name: 'Sam Ortiz' }),
      // not performed / not counted
      record('2026-10-01', { id: 'rec-declined', structured_notes: { visitOutcome: 'customer_declined' } }),
      record('2026-10-08', { id: 'rec-insp', structured_notes: { visitOutcome: 'inspection_only' } }),
      record('2026-10-15', { id: 'rec-incomplete', structured_notes: { visitOutcome: 'incomplete' } }),
      record('2026-10-22', { id: 'rec-backfill', structured_notes: { backfill: true } }),
    ],
    service_products: [
      { targets: ['Ghost ants', 'ghost ants', 'Roaches'] },
      { targets: ['Ghost ants', 'Crabgrass'] },
      { targets: ['This area is safe for pets', '3 minute re-entry', 'Chinch bugs', 'Dollarweed', 'Spiders', 'Fire ants'] },
      { targets: ['Deep green color', 'Root strength & stress tolerance', 'Orb-weaver spiders'] },
      { targets: ['Orb weaver spiders', 'orb weaver spiders'] },
      { targets: null },
    ],
    lawn_assessments: [
      { id: 'a1', turf_density: 60, weed_suppression: 60, color_health: 60, stress_damage: 60, overall_score: 61, service_date: '2026-03-01' },
      { id: 'a2', turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70, overall_score: 66, service_date: '2026-06-01' },
      { id: 'a3', turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: 80, overall_score: 78, service_date: '2026-11-01' },
    ],
    lawn_assessment_photos: [
      { assessment_id: 'a1', s3_key: 'lawn/a1.jpg' },
      { assessment_id: 'a3', s3_key: 'pending/a3.jpg' },
      { assessment_id: 'a2', s3_key: 'lawn/a2.jpg' },
    ],
  });

  test('counts performed service days, the split by line, and names the top technician', async () => {
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables: baseTables() }) });
    expect(out.enabled).toBe(true);
    expect(out.year).toBe(2026);
    // Pest on 4 days plus the Oct 22 backfill = 5; lawn on Apr 7 and Jun 9 (same days as pest) = 2; mosquito 1.
    // The total adds the lines up: 5 + 2 + 1.
    expect(out.visits.total).toBe(8);
    expect(out.visits.byLine).toEqual([
      { line: 'pest', count: 5 },
      { line: 'lawn', count: 2 },
      { line: 'mosquito', count: 1 },
    ]);
    expect(out.visits.byLine.reduce((sum, l) => sum + l.count, 0)).toBe(out.visits.total);
    expect(out.technicianFirstName).toBe('Jordan');
    expect(out.businessName).toBe(WAVES_BUSINESS_NAME);
    expect(out.businessName).toBe('Waves Pest Control, LLC');
  });

  test('lawn score is the first and last confirmed score of the year, by the app score formula', async () => {
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables: baseTables() }) });
    expect(out.lawnScore).toEqual({ first: 61, last: 78 });
  });

  test('lawn score needs two or more confirmed assessments in the year', async () => {
    const tables = baseTables();
    tables.lawn_assessments = tables.lawn_assessments.slice(0, 1);
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables }) });
    expect(out.enabled).toBe(true);
    expect(out).not.toHaveProperty('lawnScore');
  });

  test('treatedFor drops banned wording, digits and fertilizer goals, merges case and spelling, ranks by count and caps at 5', async () => {
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables: baseTables() }) });
    expect(out.treatedFor).toHaveLength(5);
    expect(out.treatedFor[0]).toBe('Ghost ants');
    // Three spellings of one spider are one entry, ranked by all three.
    expect(out.treatedFor[1]).toBe('Orb-weaver spiders');
    expect(out.treatedFor.join('|')).not.toMatch(/color|strength/i);
    expect(out.treatedFor.join('|')).not.toMatch(/safe|minute|3/i);
    expect(new Set(out.treatedFor.map((t) => t.toLowerCase())).size).toBe(5);
  });

  test('treatedFor skips visits whose report is held back from the customer', async () => {
    const tables = baseTables();
    tables.service_records = tables.service_records.map((r) => ({ ...r, structured_notes: { typedReportDelivery: 'internal_only' } }));
    const database = fakeDb({ tables });
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database });
    expect(out.treatedFor).toEqual([]);
    expect(database.reads).not.toContain('service_products');
  });

  test('photoUrl is a signed URL of the latest usable best photo, never a storage key', async () => {
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables: baseTables() }) });
    // a3's photo is still pending/, so a2's is the latest usable one.
    expect(out.photoUrl).toBe('https://signed.example/lawn/a2.jpg?sig=1');
  });

  test('fewer than 3 performed visits is { enabled: false } and reads nothing else', async () => {
    const tables = baseTables();
    tables.service_records = [record('2026-02-03'), record('2026-04-07'), record('2026-04-07', { id: 'x' }), record('2026-05-01', { structured_notes: { visitOutcome: 'customer_declined' } })];
    const database = fakeDb({ tables });
    expect(await buildYardWrapped({ customerId: 'c1', year: 2026, database })).toEqual({ enabled: false });
    expect(database.reads).toEqual(['service_records']);
  });

  test('a pest and a lawn visit on one day are two visits, so two such days reach the 3-visit card', async () => {
    const tables = baseTables();
    tables.service_records = [record('2026-02-03'), record('2026-04-07'), record('2026-04-07', { id: 'x', service_line: 'lawn' })];
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables }) });
    expect(out.visits).toEqual({ total: 3, byLine: [{ line: 'pest', count: 2 }, { line: 'lawn', count: 1 }] });
  });

  test('a failed read drops that field and never throws', async () => {
    const tables = baseTables();
    const out = await buildYardWrapped({
      customerId: 'c1', year: 2026, database: fakeDb({ tables, failing: { service_products: 1, lawn_assessments: 1 } }),
    });
    expect(out.enabled).toBe(true);
    expect(out.visits.total).toBe(8);
    expect(out.treatedFor).toEqual([]);
    expect(out).not.toHaveProperty('lawnScore');
    expect(out).not.toHaveProperty('photoUrl');
  });

  test('a failed visits read is { enabled: false } (nothing to show)', async () => {
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables: baseTables(), failing: { service_records: 1 } }) });
    expect(out).toEqual({ enabled: false });
  });

  test('the top technician is ranked in the card\'s own visit unit: a pest and a lawn visit on one day are two', async () => {
    const tables = baseTables();
    const lee = { technician_id: 't3', technician_name: 'Lee Park' };
    tables.service_records = [
      ...['2026-02-01', '2026-03-01', '2026-04-01'].map((d) => record(d)),
      ...['2026-05-01', '2026-06-01'].flatMap((d) => [record(d, { id: `p-${d}`, ...lee }), record(d, { id: `l-${d}`, service_line: 'lawn', ...lee })]),
    ];
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables }) });
    // Jordan: 3 pest visits on 3 days. Lee: pest and lawn on 2 days = 4 visits.
    expect(out.technicianFirstName).toBe('Lee');
  });

  test('a selected saved house with the lawn history gate off: no lawn score or photo, and no customer-wide lawn read', async () => {
    const before = process.env.GATE_LAWN_PROPERTY_HISTORY;
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    try {
      const database = fakeDb({ tables: baseTables() });
      const scope = { customerId: 'c1', enabled: true, multi: true, scoped: true, closed: false, property: { id: 'house-2' } };
      const out = await buildYardWrapped({ customerId: 'c1', year: 2026, scope, database });
      expect(out.enabled).toBe(true);
      expect(out).not.toHaveProperty('lawnScore');
      expect(out).not.toHaveProperty('photoUrl');
      expect(database.reads).not.toContain('lawn_assessments');
      expect(database.reads).not.toContain('lawn_assessment_photos');
    } finally { if (before === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = before; }
  });

  test('a technician name that is not a plain first name is left out', async () => {
    const tables = baseTables();
    tables.service_records = tables.service_records.map((r) => ({ ...r, technician_name: '555-0100 office' }));
    const out = await buildYardWrapped({ customerId: 'c1', year: 2026, database: fakeDb({ tables }) });
    expect(out).not.toHaveProperty('technicianFirstName');
  });
});
