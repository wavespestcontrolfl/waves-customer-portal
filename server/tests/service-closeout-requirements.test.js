const {
  normalizeRequirements,
  buildCloseoutRequirementsSnapshot,
  frozenCloseoutRequirements,
  resolveCloseoutRequirementsForJobs,
  resolveCloseoutRequirementsSnapshotForCompletion,
} = require('../services/service-closeout-requirements');

// Minimal knex stub for the resolver: every services query resolves to
// `rowsOrError` (or rejects when it is an Error). Tracks call count so tests
// can assert the catalog was NOT touched for frozen jobs.
function stubKnex(rowsOrError) {
  const k = (table) => {
    k.calls.push(table);
    // The visit's add-on rows (area add-ons fold into the requirements): none here.
    const outcome = () => (String(table).startsWith('scheduled_service_addons')
      ? Promise.resolve([])
      : rowsOrError instanceof Error
        ? Promise.reject(rowsOrError)
        : Promise.resolve(rowsOrError));
    const qb = {
      select: () => qb,
      leftJoin: () => qb,
      where: () => qb,
      whereIn: () => qb,
      orWhereIn: () => qb,
      then: (res, rej) => outcome().then(res, rej),
      catch: (fn) => outcome().catch(fn),
    };
    return qb;
  };
  k.calls = [];
  k.raw = (sql) => sql;
  k.schema = { hasColumn: async () => true };
  k.transaction = (fn) => Promise.resolve(fn(k));
  return k;
}

const CATALOG_ROW = {
  id: 'svc_frozen',
  name: 'Termite Treatment Service',
  category: 'termite',
  requires_service_report: true,
  requires_application_log: true,
  required_photo_count: 3,
  requires_customer_signature: false,
  requires_customer_notice: true,
  requires_license: true,
  license_category: 'GHP',
  closeout_requirements_source: 'manual',
};

describe('service closeout requirements', () => {
  test('uses explicit service catalog closeout flags when present', () => {
    const result = normalizeRequirements({
      id: 'svc_1',
      name: 'Termite Treatment Service',
      category: 'termite',
      requires_service_report: true,
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_signature: false,
      requires_customer_notice: true,
      requires_license: true,
      license_category: 'GHP',
      closeout_requirements_source: 'manual',
    });

    expect(result).toMatchObject({
      serviceId: 'svc_1',
      requiresServiceReport: true,
      requiresApplicationLog: true,
      requiredPhotoCount: 2,
      requiresCustomerNotice: true,
      requiresLicense: true,
      licenseCategory: 'GHP',
      source: 'manual',
    });
  });

  test('does not require an application log for inspection-only services', () => {
    const result = normalizeRequirements({}, 'WDO Inspection Service');
    expect(result.requiresServiceReport).toBe(true);
    expect(result.requiresApplicationLog).toBe(false);
    expect(result.requiredPhotoCount).toBe(2);
    expect(result.source).toBe('fallback_inference');
  });

  test('falls back to application-log requirements for treatment labels', () => {
    const result = normalizeRequirements({}, 'Monthly Mosquito Treatment');
    expect(result.requiresApplicationLog).toBe(true);
    expect(result.requiresCustomerNotice).toBe(true);
  });

  test('infers requirements for catalog rows with default inferred source', () => {
    const result = normalizeRequirements({
      id: 'svc_2',
      name: 'Mosquito Event Treatment',
      category: 'mosquito',
      requires_service_report: true,
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_notice: false,
      closeout_requirements_source: 'inferred_v1',
    });

    expect(result.requiresApplicationLog).toBe(true);
    expect(result.requiresCustomerNotice).toBe(true);
    expect(result.source).toBe('inferred_v1');
  });

  test('respects manual catalog overrides for application services', () => {
    const result = normalizeRequirements({
      id: 'svc_3',
      name: 'Mosquito Customer Education',
      category: 'mosquito',
      requires_application_log: false,
      requires_customer_notice: false,
      closeout_requirements_source: 'manual',
    });

    expect(result.requiresApplicationLog).toBe(false);
    expect(result.requiresCustomerNotice).toBe(false);
    expect(result.source).toBe('manual');
  });

  test('lawn + tree & shrub combo resolves identically under inference and the migrated columns (audit 2026-07-18)', () => {
    // The combo row shipped with bare column defaults (source inferred_v1),
    // so the feed inferred at read time; migration 20260719100000 writes the
    // inference-correct values column-authoritatively (combined_lane_v1).
    // Both regimes must agree — the migration changes provenance, never
    // requirements.
    const comboRow = { id: 'svc_combo', name: 'Lawn + Tree & Shrub', category: 'lawn_care' };
    const inferred = normalizeRequirements({
      ...comboRow,
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_notice: false,
      closeout_requirements_source: 'inferred_v1',
    });
    const migrated = normalizeRequirements({
      ...comboRow,
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_notice: true,
      closeout_requirements_source: 'combined_lane_v1',
    });
    for (const shape of [inferred, migrated]) {
      expect(shape.requiresApplicationLog).toBe(true);
      expect(shape.requiredPhotoCount).toBe(2);
      expect(shape.requiresCustomerNotice).toBe(true);
    }
  });
});

describe('closeout requirements freeze', () => {
  test('snapshot round-trips through the frozen reader', () => {
    const requirements = normalizeRequirements(CATALOG_ROW, null);
    const snap = buildCloseoutRequirementsSnapshot(requirements, { now: new Date('2026-08-31T12:00:00Z') });
    expect(snap).toMatchObject({ v: 1, frozenAt: '2026-08-31T12:00:00.000Z', source: 'manual' });

    const frozen = frozenCloseoutRequirements(JSON.stringify({ closeoutRequirements: snap }));
    expect(frozen).toMatchObject({
      serviceId: 'svc_frozen',
      serviceName: 'Termite Treatment Service',
      requiresServiceReport: true,
      requiresApplicationLog: true,
      requiredPhotoCount: 3,
      requiresCustomerNotice: true,
      requiresLicense: true,
      licenseCategory: 'GHP',
      source: 'manual',
      frozen: true,
      frozenAt: '2026-08-31T12:00:00.000Z',
    });
    // Parsed-object input (a caller that already has structured_notes as an
    // object) reads identically.
    expect(frozenCloseoutRequirements({ closeoutRequirements: snap })).toMatchObject({ frozen: true });
  });

  test('malformed snapshots are NOT frozen — live fallback', () => {
    expect(frozenCloseoutRequirements(null)).toBeNull();
    expect(frozenCloseoutRequirements('not json')).toBeNull();
    expect(frozenCloseoutRequirements(JSON.stringify({}))).toBeNull();
    expect(frozenCloseoutRequirements(JSON.stringify({ closeoutRequirements: [] }))).toBeNull();
    // A COMPLETE valid snapshot to perturb per-field below.
    const valid = buildCloseoutRequirementsSnapshot(normalizeRequirements(CATALOG_ROW, null));
    expect(frozenCloseoutRequirements({ closeoutRequirements: valid })).not.toBeNull();
    // A PARTIAL snapshot must never freeze — a permissive reader defaulting
    // a missing flag to false would suppress required closeout work
    // (pre-push codex P1).
    for (const field of ['v', 'source', 'requiresServiceReport', 'requiresApplicationLog',
      'requiresCustomerSignature', 'requiresCustomerNotice', 'requiresLicense', 'requiredPhotoCount']) {
      const { [field]: dropped, ...partial } = valid;
      expect(frozenCloseoutRequirements({ closeoutRequirements: partial })).toBeNull();
    }
    // Wrong types and out-of-range values.
    expect(frozenCloseoutRequirements({ closeoutRequirements: { ...valid, requiresServiceReport: 'yes' } })).toBeNull();
    expect(frozenCloseoutRequirements({ closeoutRequirements: { ...valid, requiredPhotoCount: 'many' } })).toBeNull();
    expect(frozenCloseoutRequirements({ closeoutRequirements: { ...valid, requiredPhotoCount: null } })).toBeNull();
    expect(frozenCloseoutRequirements({ closeoutRequirements: { ...valid, requiredPhotoCount: -1 } })).toBeNull();
    expect(frozenCloseoutRequirements({ closeoutRequirements: { ...valid, v: 2 } })).toBeNull();
  });

  test('a frozen "as inferred" snapshot IS honored', () => {
    const snap = buildCloseoutRequirementsSnapshot(normalizeRequirements({}, 'WDO Inspection Service'));
    expect(snap.source).toBe('fallback_inference');
    const frozen = frozenCloseoutRequirements({ closeoutRequirements: snap });
    expect(frozen).toMatchObject({ frozen: true, source: 'fallback_inference', requiredPhotoCount: 2 });
  });

  test('write-side resolver: lookup failure freezes NOTHING', async () => {
    const snap = await resolveCloseoutRequirementsSnapshotForCompletion({
      trx: stubKnex(new Error('catalog unavailable')),
      serviceId: 'ss1',
      catalogServiceId: 'svc_frozen',
    });
    expect(snap).toBeNull();
  });

  test('write-side resolver: missing catalog row freezes the fallback inference', async () => {
    const snap = await resolveCloseoutRequirementsSnapshotForCompletion({
      trx: stubKnex([]),
      serviceId: 'ss1',
      catalogServiceId: null,
      serviceType: 'WDO Inspection Service',
    });
    expect(snap).toMatchObject({ source: 'fallback_inference', requiredPhotoCount: 2, requiresApplicationLog: false });
  });

  test('write-side resolver: happy path freezes the catalog verdict', async () => {
    const snap = await resolveCloseoutRequirementsSnapshotForCompletion({
      trx: stubKnex([CATALOG_ROW]),
      serviceId: 'ss1',
      catalogServiceId: 'svc_frozen',
    });
    expect(snap).toMatchObject({
      v: 1,
      serviceId: 'svc_frozen',
      source: 'manual',
      requiredPhotoCount: 3,
      requiresLicense: true,
    });
    expect(typeof snap.frozenAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Codex round 8 P1 on #6135: one application log for any number of chemical add-ons.
// The requirement names the chemical add-ons that each need an application row.
// ---------------------------------------------------------------------------
describe('area add-ons: the requirement names each chemical add-on that owes its own application row', () => {
  const VISIT = '11111111-1111-4111-8111-111111111111';
  const row = (key, over = {}) => ({
    id: `cat-${key}`, name: key, category: 'lawn_care', service_key: key, requires_service_report: true, requires_application_log: true,
    required_photo_count: 0, requires_customer_signature: false, requires_customer_notice: true, requires_license: true,
    license_category: 'L&O', closeout_requirements_source: 'manual', ...over,
  });
  const HOST = { id: 'cat-lawn', name: 'Lawn Care', category: 'lawn_care', service_key: 'lawn_standard', requires_application_log: true, requires_license: false, closeout_requirements_source: 'manual' };
  const SPOT = row('area_addon_lawn_insect_spot');
  const PREVENTIVE = row('area_addon_lawn_insect_preventive');
  const SWEEP = row('area_addon_web_sweep', { requires_application_log: false, requires_customer_notice: false, requires_license: false, license_category: null });

  // A fake knex over catalog rows and the visit's add-on rows (by service key).
  function knexWith({ catalog, addOnKeys = [] }) {
    const k = (table) => {
      k.calls.push(table);
      let keys = null;
      const q = {
        select: () => q,
        leftJoin: () => q,
        where: () => q,
        orWhereIn: () => q,
        whereIn: (col, values) => { if (col === 'service_key') keys = values; return q; },
        then: (res, rej) => {
          const out = String(table).startsWith('scheduled_service_addons')
            ? addOnKeys.map((key) => ({ scheduled_service_id: VISIT, service_key: key }))
            : catalog.filter((r) => !keys || keys.includes(r.service_key));
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    };
    k.calls = [];
    k.raw = (sql) => sql;
    k.schema = { hasColumn: async () => true };
    return k;
  }
  const resolve = async (job, setup) => (await resolveCloseoutRequirementsForJobs([{ id: VISIT, ...job }], { knex: knexWith(setup), strict: true })).get(VISIT);

  test('two chemical add-ons on a lawn host: both keys, and the host owes a log of its own', async () => {
    const req = await resolve({ service_id: HOST.id }, { catalog: [HOST, SPOT, PREVENTIVE], addOnKeys: [SPOT.service_key, PREVENTIVE.service_key] });
    expect(req).toMatchObject({
      requiresApplicationLog: true,
      areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot', 'area_addon_lawn_insect_preventive'],
      hostApplicationLog: true,
    });
  });

  test('a web sweep beside one chemical add-on: only the chemical one owes a log', async () => {
    const req = await resolve({ service_id: HOST.id }, { catalog: [HOST, SPOT, SWEEP], addOnKeys: [SWEEP.service_key, SPOT.service_key] });
    expect(req.areaAddOnApplicationKeys).toEqual(['area_addon_lawn_insect_spot']);
    // The web sweep alone needs none: no list, the requirement is exactly the visit's own.
    const sweepOnly = await resolve({ service_id: HOST.id }, { catalog: [HOST, SWEEP], addOnKeys: [SWEEP.service_key] });
    expect(sweepOnly).not.toHaveProperty('areaAddOnApplicationKeys');
    expect(sweepOnly).not.toHaveProperty('hostApplicationLog');
  });

  test('the add-on that IS the visit counts, and has no host log; a second add-on row adds its own', async () => {
    const own = await resolve({ service_id: SPOT.id }, { catalog: [SPOT, PREVENTIVE], addOnKeys: [PREVENTIVE.service_key] });
    expect(own).toMatchObject({ areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot', 'area_addon_lawn_insect_preventive'], hostApplicationLog: false });
    // A web sweep as the visit with a chemical add-on row: the chemical add-on is listed, the sweep is not a host that owes a log.
    const sweepHost = await resolve({ service_id: SWEEP.id }, { catalog: [SWEEP, SPOT], addOnKeys: [SPOT.service_key] });
    expect(sweepHost).toMatchObject({ areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot'], hostApplicationLog: false });
  });

  test('a visit with no area add-on is exactly what it was: no new field at all', async () => {
    const req = await resolve({ service_id: HOST.id }, { catalog: [HOST] });
    expect(req).toEqual(normalizeRequirements(HOST));
  });

  test('an old migration\'s synthetic id reads no add-on table (and the main query still selects the catalog key)', async () => {
    const knex = knexWith({ catalog: [HOST] });
    const map = await resolveCloseoutRequirementsForJobs([{ id: 'combo', service_id: HOST.id }], { knex, strict: true });
    expect(map.get('combo')).toEqual(normalizeRequirements(HOST));
    expect(knex.calls).toEqual(['services']);
  });

  test('the list is frozen into the snapshot at completion and read back; a snapshot without it keeps its original verdict', async () => {
    const req = await resolve({ service_id: HOST.id }, { catalog: [HOST, SPOT, PREVENTIVE], addOnKeys: [SPOT.service_key, PREVENTIVE.service_key] });
    const snap = buildCloseoutRequirementsSnapshot(req);
    expect(snap).toMatchObject({ areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot', 'area_addon_lawn_insect_preventive'], hostApplicationLog: true });
    expect(frozenCloseoutRequirements({ closeoutRequirements: snap })).toMatchObject({
      frozen: true, areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot', 'area_addon_lawn_insect_preventive'], hostApplicationLog: true,
    });
    // A snapshot frozen without the list (every visit completed before this, or with the gate off) reads as it always did.
    const { areaAddOnApplicationKeys, hostApplicationLog, ...old } = snap;
    const frozenOld = frozenCloseoutRequirements({ closeoutRequirements: old });
    expect(frozenOld).toMatchObject({ frozen: true, requiresApplicationLog: true });
    expect(frozenOld).not.toHaveProperty('areaAddOnApplicationKeys');
    // A visit with no add-on freezes the same snapshot as before (no new key).
    expect(buildCloseoutRequirementsSnapshot(normalizeRequirements(HOST))).not.toHaveProperty('areaAddOnApplicationKeys');
  });

  test('a malformed list never freezes: wrong type, empty, a non-add-on key, or no host flag', () => {
    const base = buildCloseoutRequirementsSnapshot(normalizeRequirements(HOST));
    const read = (extra) => frozenCloseoutRequirements({ closeoutRequirements: { ...base, ...extra } });
    for (const extra of [
      { areaAddOnApplicationKeys: 'area_addon_lawn_insect_spot', hostApplicationLog: true },
      { areaAddOnApplicationKeys: [], hostApplicationLog: true },
      { areaAddOnApplicationKeys: ['lawn_standard'], hostApplicationLog: true },
      { areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot'] },
      { areaAddOnApplicationKeys: ['area_addon_lawn_insect_spot'], hostApplicationLog: 'yes' },
    ]) {
      const frozen = read(extra);
      expect(frozen).toMatchObject({ frozen: true });
      expect(frozen).not.toHaveProperty('areaAddOnApplicationKeys');
    }
  });
});
