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
    const outcome = () => (rowsOrError instanceof Error
      ? Promise.reject(rowsOrError)
      : Promise.resolve(rowsOrError));
    const qb = {
      select: () => qb,
      where: () => qb,
      whereIn: () => qb,
      orWhereIn: () => qb,
      then: (res, rej) => outcome().then(res, rej),
      catch: (fn) => outcome().catch(fn),
    };
    return qb;
  };
  k.calls = [];
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
    // Wrong type on the anchor boolean.
    expect(frozenCloseoutRequirements(JSON.stringify({
      closeoutRequirements: { requiresServiceReport: 'yes', requiredPhotoCount: 2 },
    }))).toBeNull();
    // Non-finite photo count.
    expect(frozenCloseoutRequirements(JSON.stringify({
      closeoutRequirements: { requiresServiceReport: true, requiredPhotoCount: 'many' },
    }))).toBeNull();
  });

  test('a frozen "as inferred" snapshot IS honored', () => {
    const snap = buildCloseoutRequirementsSnapshot(normalizeRequirements({}, 'WDO Inspection Service'));
    expect(snap.source).toBe('fallback_inference');
    const frozen = frozenCloseoutRequirements({ closeoutRequirements: snap });
    expect(frozen).toMatchObject({ frozen: true, source: 'fallback_inference', requiredPhotoCount: 2 });
  });

  test('resolver: frozen job wins over a conflicting catalog row and skips the catalog', async () => {
    const snap = buildCloseoutRequirementsSnapshot(normalizeRequirements(CATALOG_ROW, null));
    const mutatedCatalog = stubKnex([{ ...CATALOG_ROW, required_photo_count: 99 }]);
    const map = await resolveCloseoutRequirementsForJobs(
      [{ id: 'job1', service_id: 'svc_frozen' }],
      {
        knex: mutatedCatalog,
        frozenByJobId: new Map([['job1', JSON.stringify({ closeoutRequirements: snap })]]),
      },
    );
    expect(map.get('job1')).toMatchObject({ requiredPhotoCount: 3, frozen: true });
    // Every job frozen ⇒ zero catalog queries.
    expect(mutatedCatalog.calls).toHaveLength(0);
  });

  test('resolver: mixed batch queries the catalog only for unfrozen jobs', async () => {
    const snap = buildCloseoutRequirementsSnapshot(normalizeRequirements(CATALOG_ROW, null));
    const knex = stubKnex([{ ...CATALOG_ROW, id: 'svc_live', required_photo_count: 5 }]);
    const map = await resolveCloseoutRequirementsForJobs(
      [
        { id: 'jobFrozen', service_id: 'svc_frozen' },
        { id: 'jobLive', service_id: 'svc_live' },
      ],
      { knex, frozenByJobId: new Map([['jobFrozen', { closeoutRequirements: snap }]]) },
    );
    expect(map.get('jobFrozen')).toMatchObject({ requiredPhotoCount: 3, frozen: true });
    expect(map.get('jobLive')).toMatchObject({ requiredPhotoCount: 5 });
    expect(map.get('jobLive').frozen).toBeUndefined();
    expect(knex.calls).toHaveLength(1);
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
