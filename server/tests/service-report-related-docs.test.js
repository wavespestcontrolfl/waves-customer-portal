// Owner asks 2026-08-27 on the customer service report:
//  - termite-line reports carry the customer's active termite bond
//    (renewal date + portal link), riding the SAME gate as the portal
//    My Plan bond card (GATE_PORTAL_TERMITE_BOND), live views only;
//  - every live report carries relatedDocuments (documents tied to this
//    service record by linked_service_record_id, plus the customer's
//    on-file count) for the "Your documents" hero cell;
//  - nextAppointment falls back to the customer's next visit of ANY
//    service line when no same-line visit is scheduled (the rendered
//    label always carries the service name).
//
// Uses the same fixture-backed knex stub pattern as service-report-v1
// tests, generalized: any chained method returns the query; first()
// resolves the first fixture row; the object is thenable.

const {
  buildReportV1Data,
  normalizeAdvisoryForTreatmentScope,
} = require('../services/service-report/report-data');

function fixtureKnex(fixtures) {
  const knex = (table) => {
    const rows = fixtures[table] || [];
    const query = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'first') return () => Promise.resolve(rows[0] || null);
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows.slice()).then(resolve, reject);
        if (prop === 'catch') return () => Promise.resolve(rows.slice());
        if (prop === 'columnInfo') return () => Promise.resolve({});
        return () => query;
      },
    });
    return query;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const BASE_SERVICE = {
  id: 'record-1',
  customer_id: 'customer-1',
  scheduled_service_id: 'sched-1',
  service_date: '2026-08-20',
  first_name: 'Mia',
  last_name: 'Harper',
  areas_serviced: JSON.stringify([]),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};

const EMPTY_TABLES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  scheduled_services: [],
  customer_documents: [],
  termite_bonds: [],
};

describe('termiteBond on the report payload', () => {
  afterEach(() => { delete process.env.GATE_PORTAL_TERMITE_BOND; });

  const bondRow = {
    service_type: 'Termite Bond (1 Year)',
    term_years: 1,
    started_at: '2026-03-14',
    renews_at: '2027-03-14',
    status: 'active',
  };

  test('live termite report with the gate on carries the bond', async () => {
    process.env.GATE_PORTAL_TERMITE_BOND = 'true';
    const knex = fixtureKnex({ ...EMPTY_TABLES, termite_bonds: [bondRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-bond', knex, { mode: 'live' });
    expect(data.termiteBonds).toEqual([
      expect.objectContaining({ termYears: 1, startedAt: '2026-03-14', renewsAt: '2027-03-14' }),
    ]);
  });

  test('gate off → no bond even with an active row', async () => {
    const knex = fixtureKnex({ ...EMPTY_TABLES, termite_bonds: [bondRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-bond', knex, { mode: 'live' });
    expect(data.termiteBonds).toBeNull();
  });

  test('non-live mode → no bond (renewal dates must not freeze into PDFs)', async () => {
    process.env.GATE_PORTAL_TERMITE_BOND = 'true';
    const knex = fixtureKnex({ ...EMPTY_TABLES, termite_bonds: [bondRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-bond', knex, { mode: 'pdf' });
    expect(data.termiteBonds).toBeNull();
  });

  test('non-termite line → no bond', async () => {
    process.env.GATE_PORTAL_TERMITE_BOND = 'true';
    const knex = fixtureKnex({ ...EMPTY_TABLES, termite_bonds: [bondRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
    }, 'token-bond', knex, { mode: 'live' });
    expect(data.termiteBonds).toBeNull();
  });

  test('every active bond is carried, not just the farthest renewal', async () => {
    process.env.GATE_PORTAL_TERMITE_BOND = 'true';
    const knex = fixtureKnex({ ...EMPTY_TABLES, termite_bonds: [
      { ...bondRow, service_type: 'Termite Bond (5 Year)', term_years: 5, renews_at: '2031-03-14' },
      bondRow,
    ] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-bond', knex, { mode: 'live' });
    expect(data.termiteBonds).toHaveLength(2);
    expect(data.termiteBonds.map((b) => b.renewsAt)).toEqual(['2031-03-14', '2027-03-14']);
  });
});

describe('legacy no-spray termite advisories', () => {
  test('a stored 30/120 advisory on a bait visit with no spray evidence reads back as 0/0', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
      advisory: JSON.stringify({ exterior_reentry_min: 30, interior_reentry_min: 120 }),
    }, 'token-legacy', knex, { mode: 'live' });
    expect(data.advisory).toMatchObject({ exterior_reentry_min: 0, interior_reentry_min: 0 });
  });

  test('a technician-adjusted side is preserved', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
      advisory: JSON.stringify({ exterior_reentry_min: 45, interior_reentry_min: 120, reentry_adjusted: { exterior: true } }),
    }, 'token-legacy', knex, { mode: 'live' });
    expect(data.advisory.exterior_reentry_min).toBe(45);
    expect(data.advisory.interior_reentry_min).toBe(0);
  });

  test('the legacy boolean reentry_adjusted marker protects both sides', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
      advisory: JSON.stringify({ exterior_reentry_min: 45, interior_reentry_min: 90, reentry_adjusted: true }),
    }, 'token-legacy', knex, { mode: 'live' });
    expect(data.advisory.interior_reentry_min).toBe(90);
  });

  test('a legacy methodless termiticide row (inferred station_check) is treatment evidence', async () => {
    const knex = fixtureKnex({
      ...EMPTY_TABLES,
      service_products: [{
        id: 'sp1', service_record_id: 'record-1', product_name: 'Termidor SC',
        epa_reg_number: '7969-210', product_category: 'termiticide', application_method: null,
      }],
    });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
      advisory: JSON.stringify({ exterior_reentry_min: 30, interior_reentry_min: 120 }),
    }, 'token-legacy', knex, { mode: 'live' });
    // Interior guidance survives (the legacy rewrite did not run); the
    // exterior side is governed by the existing treatment-scope
    // normalization (no exterior spray zone on a station_check row).
    expect(data.advisory.interior_reentry_min).toBe(120);
  });

  test('an EXPLICIT station check on a bait product is not treatment evidence', async () => {
    const knex = fixtureKnex({
      ...EMPTY_TABLES,
      service_products: [{
        id: 'sp1', service_record_id: 'record-1', product_name: 'Trelona ATBS',
        epa_reg_number: '499-557', product_category: 'termite bait', application_method: 'station_check',
      }],
    });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
      advisory: JSON.stringify({ exterior_reentry_min: 30, interior_reentry_min: 120 }),
    }, 'token-legacy', knex, { mode: 'live' });
    expect(data.advisory).toMatchObject({ exterior_reentry_min: 0, interior_reentry_min: 0 });
  });

  test('a treatment-applied protocol action keeps the stored guidance', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Inspection Service',
      advisory: JSON.stringify({ exterior_reentry_min: 30, interior_reentry_min: 120 }),
      structured_notes: JSON.stringify({ protocolActionScopesCompleted: [{ label: 'Spot-treated a mud tube', scope: 'exterior', treatmentApplied: true }] }),
    }, 'token-legacy', knex, { mode: 'live' });
    expect(data.advisory.exterior_reentry_min).toBe(30);
  });
});

describe('relatedDocuments on the report payload', () => {
  test('live report lists linked-doc titles and the on-file count', async () => {
    const knex = fixtureKnex({
      ...EMPTY_TABLES,
      // The stub returns whatever the table holds regardless of predicates;
      // the linked-only filter now lives in the query itself, so the
      // fixture models the linked rows that query returns.
      customer_documents: [
        { id: 'd1', title: 'WDO Notice of Inspection', document_type: 'wdo_inspection', linked_service_record_id: 'record-1' },
      ],
    });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
    }, 'token-docs', knex, { mode: 'live' });
    // Never a count (the Documents tab also synthesizes report rows, so
    // any number computed here would disagree with it).
    expect(data.relatedDocuments.totalCount).toBeUndefined();
    expect(data.relatedDocuments.linked).toEqual([
      { title: 'WDO Notice of Inspection', documentType: 'wdo_inspection' },
    ]);
  });

  test('no stored documents → still present with no linked titles (the tab holds this report)', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
    }, 'token-docs', knex, { mode: 'live' });
    expect(data.relatedDocuments).toEqual({ linked: [] });
  });

  test('non-live mode → null', async () => {
    const knex = fixtureKnex({
      ...EMPTY_TABLES,
      customer_documents: [
        { id: 'd1', title: 'Service Agreement', document_type: 'service_agreement', linked_service_record_id: null },
      ],
    });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
    }, 'token-docs', knex, { mode: 'pdf' });
    expect(data.relatedDocuments).toBeNull();
  });
});

describe('recommendations are screened at the payload boundary', () => {
  test('banned wording and access codes drop; clean lines still render', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      structured_notes: JSON.stringify({
        formRecommendations: [
          'Keep shrubs trimmed back from the exterior walls',
          'The side gate code is 4417 for our next visit',
          'Treated areas are completely safe for pets right away',
        ],
      }),
    }, 'token-recs', knex, { mode: 'live' });
    expect(data.recommendations).toEqual([
      'Keep shrubs trimmed back from the exterior walls',
    ]);
  });

  test('the approved "safe once dry + technician confirms timing" idiom survives; bare "safe once dry" does not', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      structured_notes: JSON.stringify({
        formRecommendations: [
          'Treated beds are safe once dry and your technician confirmed the re-entry timing on site',
          'The lanai is safe once dry',
        ],
      }),
    }, 'token-recs', knex, { mode: 'live' });
    expect(data.recommendations).toEqual([
      'Treated beds are safe once dry and your technician confirmed the re-entry timing on site',
    ]);
  });

  test('raw [Next]-tagged technician note lines never render as recommendations', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      technician_notes: '[Next] Office: bill the HOA, not the tenant\n[Next] Recheck the garage',
      structured_notes: JSON.stringify({
        // The persisted MERGED list (what completion writes) already folds
        // the note lines in — it must not drive the customer list.
        recommendations: ['Keep mulch pulled back from the slab', 'Office: bill the HOA, not the tenant', 'Recheck the garage'],
        formRecommendations: ['Keep mulch pulled back from the slab'],
      }),
    }, 'token-recs', knex, { mode: 'live' });
    expect(data.recommendations).toEqual(['Keep mulch pulled back from the slab']);
    // The merged internal list (recap consumers) still carries the note lines.
    expect(data.protocol.recommendations).toEqual(expect.arrayContaining(['Recheck the garage']));
  });

  test('records without provenance (pre-formRecommendations) render findings recommendations only', async () => {
    const knex = fixtureKnex({
      ...EMPTY_TABLES,
      service_findings: [
        { id: 'f1', category: 'observation', severity: 'low', title: 'Ant trailing', detail: '', recommendation: 'Pull mulch back from the slab' },
      ],
    });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      structured_notes: JSON.stringify({ recommendations: ['Legacy merged line with unknown provenance'] }),
    }, 'token-recs', knex, { mode: 'live' });
    expect(data.recommendations).toEqual(['Pull mulch back from the slab']);
  });
});

describe('nextAppointment cross-line fallback', () => {
  const pestRow = {
    id: 'sched-future',
    service_type: 'Recurring Pest Control',
    scheduled_date: '2099-11-18',
    window_start: '09:00:00',
    status: 'pending',
  };

  test('same-line visit still wins when present', async () => {
    const termiteRow = {
      id: 'sched-termite',
      service_type: 'Termite Bait Monitoring',
      scheduled_date: '2099-12-01',
      window_start: '10:00:00',
      status: 'confirmed',
    };
    // Fixture order puts the NEARER pest row first — the same-line pick
    // must still choose the termite row.
    const knex = fixtureKnex({ ...EMPTY_TABLES, scheduled_services: [pestRow, termiteRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-next', knex, { mode: 'live' });
    expect(data.nextAppointment).toMatchObject({
      serviceType: 'Termite Bait Monitoring',
      scheduledDate: '2099-12-01',
    });
  });

  test('no same-line visit → the next visit of any line, name included', async () => {
    const knex = fixtureKnex({ ...EMPTY_TABLES, scheduled_services: [pestRow] });
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-next', knex, { mode: 'live' });
    expect(data.nextAppointment).toMatchObject({
      serviceType: 'Recurring Pest Control',
      scheduledDate: '2099-11-18',
      windowStart: '09:00:00',
    });
  });

  test('no upcoming visits at all → null', async () => {
    const knex = fixtureKnex(EMPTY_TABLES);
    const data = await buildReportV1Data({
      ...BASE_SERVICE,
      service_line: 'termite',
      service_type: 'Termite Bait Station System Service',
    }, 'token-next', knex, { mode: 'live' });
    expect(data.nextAppointment).toBeNull();
  });
});

describe('exterior scope vocabulary covers the new termite/mosquito area labels', () => {
  const advisory = { exterior_reentry_min: 30, interior_reentry_min: 0 };
  for (const area of ['Screened enclosure', 'Standing water areas', 'Under deck / patio', 'Bait stations', 'Crawlspace', 'Garage / slab edge', 'Wood contact points']) {
    test(`${area} keeps the exterior countdown`, () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: { areas_serviced: JSON.stringify([area]) },
        applications: [{ application_area: area, application_method: 'fog_ulv' }],
      });
      expect(normalized.exterior_reentry_min).toBe(30);
    });
  }
});
