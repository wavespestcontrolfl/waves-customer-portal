// Lawn callback reports fold the fragmented cards into the narrative (owner
// 2026-08-30, first-callback eyeball): when the tech-reviewed AI report owns
// the summary, the payload drops the "What we found & did" tiles
// (typedReport.findings), the "What we recommend" list, and the lawn program
// explainer — the prose already tells that story, on web and PDF alike.
// Suppression requires ALL of: gate on, callback record, lawn line, and the
// technician_report summary source — any miss keeps every card.

// Stub presigning so a fixture treatment_zone_maps row can materialize as a
// traced map (the non-performed-outcome suppression test needs one).
jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async (key) => `https://example.test/${key}`),
  CUSTOMER_DWELL_TTL_SECONDS: 3600,
}));

const { buildReportV1Data } = require('../services/service-report/report-data');

// Minimal fixture knex — same shape as report-lawn-next-visit.test.js.
function makeKnex(fixtures = {}) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {};
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (arguments.length === 2) rows = rows.filter((r) => r[a] === b);
        return q;
      },
      andWhere() { return q; },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot() { return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const AI_REPORT = [
  'WHAT WE DID',
  '',
  'This re-service targeted broadleaf weeds across the front, back, and side yards, with a post-emergent herbicide applied to knock back dollarweed working through the turf.',
  '',
  'WHAT WE FOUND',
  '',
  // Mirrors the production narrative shape: the irrigation instruction and
  // the application reference share ONE sentence — sentence-scoped coverage
  // (codex P1 r7) requires that to fold the matching recommendation row.
  'The lawn is recovering, though weed and gray leaf spot pressure stayed active. Please stay off the grass until the application has fully dried, and hold off on any irrigation for at least 48 hours so the product isn’t washed away before it is absorbed.',
].join('\n');

function lawnCallbackService(overrides = {}) {
  return {
    id: 'svc-cb-1',
    scheduled_service_id: 'ss-cb-1',
    customer_id: 'cust-cb',
    service_line: 'lawn',
    service_type: 'Lawn Care Re-Service',
    service_date: '2026-08-30',
    is_callback: true,
    first_name: 'Test',
    last_name: 'Customer',
    technician_notes: AI_REPORT,
    areas_serviced: JSON.stringify(['Front yard']),
    structured_notes: JSON.stringify({
      formRecommendations: ['Do not apply irrigation for at least 48 hrs'],
    }),
    service_data: JSON.stringify({
      typedReportSnapshot: {
        type: 'one_time_lawn_treatment',
        todaysResult: {
          headline: 'Lawn Care Re-Service completed today',
          body: 'body',
          bodySource: 'technician_report',
        },
        findings: [
          { fieldKey: 'lawn_condition', label: 'Lawn condition', value: 'Recovering', customerValueLabel: 'Recovering' },
          { fieldKey: 'work_completed', label: 'Work completed today', value: ['Weed control applied'], customerValueParts: ['Weed control applied'] },
        ],
        values: { lawn_condition: 'Recovering' },
      },
    }),
    ...overrides,
  };
}

describe('lawn callback card fold (owner 2026-08-30)', () => {
  const OLD_GATE = process.env.GATE_RESERVICE_REPORT_COPY;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
    else process.env.GATE_RESERVICE_REPORT_COPY = OLD_GATE;
  });

  test('gate on + narrative: findings tiles, recommendations, and program explainer fold away', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const data = await buildReportV1Data(lawnCallbackService(), 'tok-fold-1', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    expect(data.isCallback).toBe(true);
    expect(data.typedReport.findings).toEqual([]);
    expect(data.recommendations).toEqual([]);
    expect(data.lawnProgramOverview).toBeNull();
  });

  test('non-callback lawn visit keeps every card', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const data = await buildReportV1Data(lawnCallbackService({ is_callback: false }), 'tok-fold-2', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    expect(data.typedReport.findings.length).toBeGreaterThan(0);
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('gate off keeps every card (kill switch restores the pre-lane render)', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const data = await buildReportV1Data(lawnCallbackService(), 'tok-fold-3', makeKnex());
    expect(data.typedReport.findings.length).toBeGreaterThan(0);
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('a recommendation the narrative does NOT cover survives the fold (codex P1 r5)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      structured_notes: JSON.stringify({
        formRecommendations: [
          'Do not apply irrigation for at least 48 hrs',
          'Trim shrubs back from the exterior walls before the next visit',
        ],
      }),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-5', makeKnex());
    // Covered by the narrative's own wording → folded away.
    expect(data.recommendations).not.toContain('Do not apply irrigation for at least 48 hrs');
    // Never mentioned in the prose → stays on the card.
    expect(data.recommendations).toContain('Trim shrubs back from the exterior walls before the next visit');
  });

  test('non-irrigation instructions always stay: "Do not mow for 48 hrs" is never folded (codex P1 r6)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      structured_notes: JSON.stringify({
        formRecommendations: ['Do not mow for 48 hrs'],
      }),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-6', makeKnex());
    expect(data.recommendations).toContain('Do not mow for 48 hrs');
  });

  test('cross-clause negation never covers: "Apply irrigation …, but do not mow" keeps the hold instruction (codex P1 r8)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      technician_notes: [
        'WHAT WE DID',
        '',
        'Weed control was applied across the turf today.',
        '',
        'WHAT WE FOUND',
        '',
        'Apply irrigation for at least 48 hours to settle the product in, but do not mow until the turf recovers.',
      ].join('\n'),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-7', makeKnex());
    // The narrative ADVISES irrigation — the opposite of the hold. No
    // clause carries irrigation + hold + duration together, so the
    // instruction stays on the card.
    expect(data.summarySource).toBe('technician_report');
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('a duration in a different conjunct never covers: "Do not water the flower beds and wait 72 hours before mowing" (codex P1 r11)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      technician_notes: [
        'WHAT WE DID',
        '',
        'Weed control was applied across the turf today.',
        '',
        'WHAT WE FOUND',
        '',
        'Do not water the flower beds and wait 72 hours before mowing.',
      ].join('\n'),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-9', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    // The 72 hours belongs to mowing, not the watering hold — the 48-hour
    // irrigation instruction stays.
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('opposite/non-hold irrigation sentences cover nothing: "Irrigation caused no runoff for 48 hours" (codex P1 r9)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      technician_notes: [
        'WHAT WE DID',
        '',
        'Weed control was applied across the turf today.',
        '',
        'WHAT WE FOUND',
        '',
        'Irrigation caused no runoff for 48 hours after the treatment. No irrigation occurred for 72 hours before today’s visit.',
      ].join('\n'),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-8', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    // Neither the pooled-token sentence nor the descriptive "No irrigation
    // occurred…" history (codex P1 r10) is a directive — the hold stays.
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('narrowed-scope watering holds never cover: "hold off on watering the flower beds" (codex P1 r12)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      technician_notes: [
        'WHAT WE DID',
        '',
        'Weed control was applied across the turf today.',
        '',
        'WHAT WE FOUND',
        '',
        'Hold off on watering the flower beds for 48 hours. Do not water the shrubs for 48 hours either.',
      ].join('\n'),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-10', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    // Both narrative holds are NARROWER than the lawn-wide instruction —
    // the property-wide hold stays on the card.
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('double-negated hold verbs never cover: "Do not skip irrigation for 48 hours" instructs the OPPOSITE (codex P1 r13)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({
      technician_notes: [
        'WHAT WE DID',
        '',
        'Weed control was applied across the turf today.',
        '',
        'WHAT WE FOUND',
        '',
        'Do not skip irrigation for 48 hours. Do not avoid watering for 48 hours.',
      ].join('\n'),
    });
    const data = await buildReportV1Data(svc, 'tok-fold-13', makeKnex());
    expect(data.summarySource).toBe('technician_report');
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });

  test('non-performed callback outcomes suppress the traced map (codex P1 r12)', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const tracedFixtures = {
      treatment_zone_maps: [{
        scheduled_service_id: 'ss-cb-1',
        snapshot_s3_key: 'service-photos/treatment-zones/x/map.png',
        mask_s3_key: null,
        linear_ft: 200,
        closed_loop: true,
        capture_mode: 'lawn',
        path_points: '[]',
        created_at: '2026-08-30T17:00:00Z',
        updated_at: '2026-08-30T17:00:00Z',
      }],
    };
    const declined = lawnCallbackService();
    {
      const parsed = JSON.parse(declined.service_data);
      parsed.typedReportSnapshot.values = { visit_outcome: 'Customer declined service' };
      declined.service_data = JSON.stringify(parsed);
      declined.structured_notes = JSON.stringify({ visitOutcome: 'customer_declined' });
    }
    const data = await buildReportV1Data(declined, 'tok-fold-11', makeKnex(tracedFixtures));
    expect(data.reserviceReport?.outcome).toBe('customer_declined');
    expect(data.treatmentMap.traced).toBeNull();
    // A PERFORMED callback keeps its trace — the suppression is
    // outcome-scoped, never callback-wide.
    const performed = await buildReportV1Data(lawnCallbackService(), 'tok-fold-12', makeKnex(tracedFixtures));
    expect(performed.reserviceReport?.outcome).toBe('treated');
    expect(performed.treatmentMap.traced?.snapshotUrl).toBeTruthy();
  });

  test('callback with NO reviewed narrative keeps every card — removal never loses the sole record', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const svc = lawnCallbackService({ technician_notes: '' });
    const parsed = JSON.parse(svc.service_data);
    delete parsed.typedReportSnapshot.todaysResult.bodySource;
    svc.service_data = JSON.stringify(parsed);
    const data = await buildReportV1Data(svc, 'tok-fold-4', makeKnex());
    expect(data.summarySource).not.toBe('technician_report');
    expect(data.typedReport.findings.length).toBeGreaterThan(0);
    expect(data.recommendations).toContain('Do not apply irrigation for at least 48 hrs');
  });
});
