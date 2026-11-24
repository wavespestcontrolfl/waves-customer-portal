/**
 * GATE_TECH_JOB_TYPE_CHECKS (owner 2026-10-25, census M2 and the warning part of H7).
 *
 * M2: the capability checks classified a visit by its NAME, so "Palm Tree Nutritional
 * Treatment" and "Top Dress" read as general pest and a technician set to Off for Lawn
 * could still get them. With the gate on the category comes from the service library
 * (services.category) first and the name only when the catalog names none.
 * H7 (warning part): an office save warns, never blocks, when the chosen technician is Off
 * for the visit's category. needs-review never warns (owner 2026-09-05).
 *
 * Mocked knex here: the table routing and the gate are what these prove. The real
 * Postgres round trip is tech-job-type-checks-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID_2 = '22222222-2222-4222-8222-222222222222';

const {
  CATALOG_CATEGORY_LINES, CATALOG_KEY_LINES, categoryForCatalogCategory, classifyServiceCategory, lineForCatalogRow,
} = require('../services/auto-dispatch/service-category');
const capabilities = require('../services/technician-capabilities');
const { capabilityOffWarningsFor } = require('../services/technician-eligibility');

// A table-routed fake knex. `catalog` = services rows; `off` = technician_capabilities rows
// with active false; `tech` = the technicians row. Records every table it was asked for.
function fakeConn({ catalog = [], off = [], tech = { name: 'Tech Two' }, catalogError = null, transaction = false } = {}) {
  const asked = [];
  const builderFor = (table) => {
    asked.push(table);
    let filters = {};
    const b = {};
    for (const m of ['where', 'orWhereIn', 'whereIn', 'forShare', 'select']) {
      b[m] = jest.fn((arg) => {
        if (m === 'where' && arg && typeof arg === 'object' && typeof arg !== 'function') filters = { ...filters, ...arg };
        if (m === 'where' && typeof arg === 'function') arg({ whereIn: () => {}, orWhereIn: () => {} });
        return b;
      });
    }
    b.first = jest.fn(async () => (table === 'technicians' ? tech : { id: 'x' }));
    b.pluck = jest.fn(async () => off.map((row) => row.service_category));
    b.then = (resolve, reject) => {
      let rows;
      if (table === 'services') {
        if (catalogError) return Promise.reject(catalogError).then(resolve, reject);
        rows = catalog;
      } else if (table === 'technician_capabilities') {
        rows = off.map((row) => ({ technician_id: 't-1', active: false, ...row }));
      } else {
        rows = [];
      }
      return Promise.resolve(rows).then(resolve, reject);
    };
    return b;
  };
  const conn = jest.fn(builderFor);
  conn.asked = asked;
  if (transaction) {
    conn.isTransaction = true;
    conn.transaction = jest.fn(async (cb) => cb(conn));
  }
  return conn;
}

const PALM = { service_type: 'Palm Tree Nutritional Treatment', service_id: SERVICE_ID };
const TOP_DRESS = { service_type: 'Top Dress', service_key_snapshot: 'lawn_top_dress' };
const CATALOG = [
  { id: SERVICE_ID, service_key: 'palm_nutritional', category: 'tree_shrub' },
  { id: SERVICE_ID_2, service_key: 'lawn_top_dress', category: 'lawn_care' },
];

afterEach(() => { delete process.env.GATE_TECH_JOB_TYPE_CHECKS; });

describe('the catalog category table (one table, shared with the service-line map)', () => {
  test('maps the five lines; inspection, specialty, other and unknown name none', () => {
    expect(CATALOG_CATEGORY_LINES).toEqual({
      pest_control: 'general', mosquito: 'mosquito', lawn_care: 'lawn', tree_shrub: 'lawn', rodent: 'rodent', termite: 'termite', wdo: 'termite',
    });
    expect(categoryForCatalogCategory(' Tree_Shrub ')).toBe('lawn');
    for (const none of ['inspection', 'specialty', 'other', '', null, undefined, 'toString']) {
      expect(categoryForCatalogCategory(none)).toBeNull();
    }
    expect(require('../services/scheduling/line-technician').CATALOG_CATEGORY_LINES).toBe(CATALOG_CATEGORY_LINES);
  });

  test('lineForCatalogRow: the key decides the rodent line; an unlisted rodent row is rodent only when its name says trapping or bait', () => {
    // Owner 2026-11-21 (rodent jobs = A): the second technician takes trapping and bait stations. Sealing,
    // sanitation, the rodent inspection, dead-rodent removal and the general first visit are the owner's line.
    const keysOf = (line) => Object.keys(CATALOG_KEY_LINES).filter((key) => CATALOG_KEY_LINES[key] === line).sort();
    expect(keysOf('exclusion')).toEqual([
      'rodent_bird_box', 'rodent_dead_animal_removal', 'rodent_exclusion', 'rodent_exclusion_only', 'rodent_general_one_time',
      'rodent_inspection', 'rodent_sanitation_heavy', 'rodent_sanitation_light', 'rodent_sanitation_standard',
      'rodent_trapping_exclusion', 'rodent_trapping_exclusion_sanitation', 'rodent_trapping_sanitation', 'rodent_wire_mesh',
    ]);
    expect(keysOf('rodent')).toEqual([
      'rodent_bait_quarterly', 'rodent_bait_setup', 'rodent_monitoring', 'rodent_trap_check_additional', 'rodent_trapping',
      'rodent_trapping_followup', 'trap_only_retainer_monthly', 'trap_only_retainer_plus', 'trap_only_retainer_standard',
    ]);
    expect(new Set(Object.values(CATALOG_KEY_LINES))).toEqual(new Set(['exclusion', 'rodent']));
    expect(lineForCatalogRow({ service_key: 'rodent_exclusion', category: 'rodent', name: 'Rodent Exclusion & Trapping Service' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'rodent_inspection', category: 'inspection', name: 'Rodent Inspection Service' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'rodent_general_one_time', category: 'rodent', name: 'Rodent Pest Control Service' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'rodent_dead_animal_removal', category: 'rodent', name: 'Dead Rodent Removal & Odor Treatment' })).toBe('exclusion');
    // A listed key keeps its line when staff rename the row to a general name, and the other way round.
    for (const key of keysOf('rodent')) {
      expect(lineForCatalogRow({ service_key: key, category: 'rodent', name: 'Rodent Control' })).toBe('rodent');
    }
    expect(lineForCatalogRow({ service_key: 'rodent_inspection', category: 'inspection', name: 'Rodent Trap Check' })).toBe('exclusion');
    // A rodent row added to the library later, with a key this list has not got: rodent only when its own name
    // says trapping or bait; anything else (no name too) is exclusion, never the trapping line by default.
    expect(lineForCatalogRow({ service_key: 'rodent_new_trap_plan', category: 'rodent', name: 'Rodent Trap Plan' })).toBe('rodent');
    expect(lineForCatalogRow({ service_key: 'rodent_bait_monthly', category: 'rodent', name: 'Monthly Rodent Bait Station Service' })).toBe('rodent');
    expect(lineForCatalogRow({ service_key: 'rodent_exclusion_whole_home', category: 'rodent', name: 'Whole-Home Rodent Exclusion Service' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'rodent_visit', category: 'rodent', name: 'Rodent Control Service' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'rodent_unnamed', category: 'rodent' })).toBe('exclusion');
    // The category already says rodent, so the name needs no rodent word: a bait or trap label is the rodent line,
    // and exclusion work beside it (a combined job is the first visit) is exclusion.
    expect(lineForCatalogRow({ service_key: 'station_refill', category: 'rodent', name: 'Bait Station Refill' })).toBe('rodent');
    expect(lineForCatalogRow({ service_key: 'retainer_new', category: 'rodent', name: 'Premium Trap-Only Retainer Service' })).toBe('rodent');
    expect(lineForCatalogRow({ service_key: 'trap_clean', category: 'rodent', name: 'Trapping & Sanitation' })).toBe('exclusion');
    expect(lineForCatalogRow({ service_key: 'attic_seal', category: 'rodent', name: 'Attic Sealing' })).toBe('exclusion');
    // The name check is for rodent rows only: another category keeps its line whatever the name says.
    expect(lineForCatalogRow({ service_key: 'k', category: 'lawn_care', name: 'Rodent Exclusion' })).toBe('lawn');
    expect(lineForCatalogRow({ service_key: 'k', category: 'other', name: 'Rodent Exclusion' })).toBeNull();
    expect(lineForCatalogRow(null)).toBeNull();
    expect(lineForCatalogRow({})).toBeNull();
  });

  test('the name regex alone reads the bug visits as general (why the catalog is needed)', () => {
    for (const name of ['Palm Tree Nutritional Treatment', 'Semiannual Palm', 'Palm Fert', 'Top Dress']) {
      expect(classifyServiceCategory(name)).toBe('general');
    }
  });
});

describe('categoriesForServices', () => {
  test('gate off: the name only, and the catalog is never read even when ids are passed', async () => {
    const conn = fakeConn({ catalog: CATALOG });
    expect(await capabilities.categoriesForServices(conn, [PALM, TOP_DRESS])).toEqual(['general', 'general']);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: the catalog category wins over the name (palm and top dress read lawn)', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG });
    expect(await capabilities.categoriesForServices(conn, [PALM, TOP_DRESS])).toEqual(['lawn', 'lawn']);
    expect(conn.asked).toEqual(['services']);
  });

  test('gate on: a service_id wins, then the service key; a key alone resolves too', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: [
      { id: SERVICE_ID, service_key: 'a', category: 'termite' },
      { id: SERVICE_ID_2, service_key: 'b', category: 'mosquito' },
    ] });
    const rows = [
      { service_type: 'Visit', service_id: SERVICE_ID, service_key: 'b' },
      { service_type: 'Visit', service_id: '33333333-3333-4333-8333-333333333333', service_key: 'b' },
      { service_type: 'Visit', service_key: 'a' },
    ];
    expect(await capabilities.categoriesForServices(conn, rows)).toEqual(['termite', 'mosquito', 'termite']);
  });

  test('gate on: a catalog row that names no category (other, inspection) falls to the name', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: [{ id: SERVICE_ID, service_key: 'k', category: 'other' }] });
    expect(await capabilities.categoriesForServices(conn, [{ service_type: 'Mosquito Misting', service_id: SERVICE_ID }]))
      .toEqual(['mosquito']);
  });

  test('gate on: a name-only row makes no catalog read and uses the regex', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG });
    expect(await capabilities.categoriesForServices(conn, [{ service_type: 'Rodent Exclusion' }, { service_type: 'Quarterly Pest' }]))
      .toEqual(['exclusion', 'general']);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate off: a key-only slot search (the key stands in for the name) reads the exclusion keys as exclusion', async () => {
    // The capacity finder has no visit name for a key-only request and passes the key as service_type.
    // A technician set Off for exclusion and On for trapping must not be offered a sealing job.
    const conn = fakeConn({ catalog: CATALOG });
    const rows = ['rodent_inspection', 'rodent_wire_mesh', 'rodent_bird_box', 'rodent_general_one_time', 'rodent_trapping'].map((key) => ({ service_type: key }));
    expect(await capabilities.categoriesForServices(conn, rows)).toEqual(['exclusion', 'exclusion', 'exclusion', 'exclusion', 'rodent']);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: an exclusion job reads exclusion and its trap check reads rodent, by service key', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: [
      { id: SERVICE_ID, service_key: 'rodent_exclusion', category: 'rodent', name: 'Rodent Exclusion & Trapping Service' },
      { id: SERVICE_ID_2, service_key: 'rodent_trapping_followup', category: 'rodent', name: 'Rodent Trapping Follow-Up Visit Service' },
    ] });
    const rows = [
      { service_type: 'Rodent Exclusion & Trapping Service', service_id: SERVICE_ID },
      { service_type: 'Rodent Trapping Follow-Up Visit Service', service_key_snapshot: 'rodent_trapping_followup' },
    ];
    expect(await capabilities.categoriesForServices(conn, rows)).toEqual(['exclusion', 'rodent']);
  });

  test('gate on: a service_id that is not a UUID is never sent to the database', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG });
    expect(await capabilities.categoriesForServices(conn, [{ service_type: 'Top Dress', service_id: 'not-a-uuid' }])).toEqual(['general']);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: an unreadable catalog falls to the name and does not throw', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalogError: new Error('boom') });
    expect(await capabilities.categoriesForServices(conn, [PALM])).toEqual(['general']);
  });

  test('on a transaction the catalog read rides a savepoint', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, transaction: true });
    await capabilities.categoriesForServices(conn, [PALM]);
    expect(conn.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('the capability fences read the same category', () => {
  const lawnOff = [{ technician_id: 't-1', service_category: 'lawn' }];

  test('inactiveCapabilitiesForServices asks for the lawn category with the gate on and general with it off', async () => {
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff });
    const asked = [];
    const spy = jest.fn((table) => {
      const b = conn(table);
      const original = b.whereIn;
      b.whereIn = jest.fn((col, values) => { if (table === 'technician_capabilities') asked.push(values); return original(col, values); });
      return b;
    });
    await capabilities.inactiveCapabilitiesForServices(spy, ['t-1'], [PALM]);
    expect(asked.pop()).toEqual(['general']);
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    await capabilities.inactiveCapabilitiesForServices(spy, ['t-1'], [PALM]);
    expect(asked.pop()).toEqual(['lawn']);
  });

  test('assertCapabilitiesActive: gate on refuses a palm visit for a Lawn = Off technician and names lawn; gate off lets it through', async () => {
    const conn = fakeConn({ catalog: CATALOG });
    // A technician_capabilities result that is Off only for lawn.
    const trx = jest.fn((table) => {
      if (table !== 'technician_capabilities') return conn(table);
      let wanted = [];
      const b = {
        where: () => b,
        whereIn: (col, values) => { if (col === 'service_category') wanted = values; return b; },
        select: () => b,
        then: (resolve, reject) => Promise.resolve(wanted.includes('lawn') ? [{ technician_id: 't-1', service_category: 'lawn', active: false }] : [])
          .then(resolve, reject),
      };
      return b;
    });
    const refuse = jest.fn((rowId, why) => Object.assign(new Error(why), { code: 'REFUSED', rowId }));
    const row = { id: 'visit-1', ...PALM };

    await expect(capabilities.assertCapabilitiesActive(trx, 't-1', [row], refuse)).resolves.toBeUndefined();

    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    await expect(capabilities.assertCapabilitiesActive(trx, 't-1', [row], refuse))
      .rejects.toMatchObject({ code: 'REFUSED', rowId: 'visit-1', message: 'cannot be assigned to a technician deactivated for lawn' });
  });
});

describe('capabilityOffWarningsFor (the office warning, never a block)', () => {
  const lawnOff = [{ service_category: 'lawn' }];

  test('gate off: nothing, and no database read', async () => {
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff });
    expect(await capabilityOffWarningsFor('t-1', [PALM], { conn })).toEqual([]);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: Off for the visit\'s catalog category warns in the off-day style', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff });
    expect(await capabilityOffWarningsFor('t-1', [PALM], { conn }))
      .toEqual(['Tech Two is set to Off for Lawn, tree & shrub work.']);
  });

  test('gate on: no Off row (qualified, needs review, or unset) means no warning and no technician read', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, off: [] });
    expect(await capabilityOffWarningsFor('t-1', [PALM], { conn })).toEqual([]);
    expect(conn.asked).not.toContain('technicians');
  });

  test('gate on: two services in one Off category give one line; two categories give two', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff });
    expect(await capabilityOffWarningsFor('t-1', [PALM, TOP_DRESS], { conn })).toHaveLength(1);
    const two = fakeConn({ catalog: CATALOG, off: [{ service_category: 'lawn' }, { service_category: 'termite' }] });
    expect(await capabilityOffWarningsFor('t-1', [PALM, { service_type: 'WDO Inspection' }], { conn: two }))
      .toEqual(['Tech Two is set to Off for Lawn, tree & shrub work.', 'Tech Two is set to Off for Termite / WDO work.']);
  });

  test('gate on: no technician, no service, or a failed read gives [] (an advisory line never blocks a save)', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff });
    expect(await capabilityOffWarningsFor(null, [PALM], { conn })).toEqual([]);
    expect(await capabilityOffWarningsFor('t-1', [], { conn })).toEqual([]);
    expect(await capabilityOffWarningsFor('t-1', [{}], { conn })).toEqual([]);
    const broken = jest.fn(() => { throw new Error('db down'); });
    expect(await capabilityOffWarningsFor('t-1', [{ service_type: 'Top Dress' }], { conn: broken })).toEqual([]);
  });

  test('on a transaction the reads ride one savepoint', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const conn = fakeConn({ catalog: CATALOG, off: lawnOff, transaction: true });
    await capabilityOffWarningsFor('t-1', [PALM], { conn });
    expect(conn.transaction).toHaveBeenCalled();
  });
});

describe('the gate', () => {
  test('is strict opt-in: only the exact string true turns it on, read at call time', () => {
    const gates = require('../config/feature-gates');
    for (const value of [undefined, '', '1', 'TRUE', 'yes', ' true']) {
      if (value === undefined) delete process.env.GATE_TECH_JOB_TYPE_CHECKS; else process.env.GATE_TECH_JOB_TYPE_CHECKS = value;
      expect(gates.techJobTypeChecksLive()).toBe(false);
    }
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    expect(gates.techJobTypeChecksLive()).toBe(true);
  });
});
