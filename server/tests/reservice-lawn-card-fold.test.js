// Lawn callback reports fold the fragmented cards into the narrative (owner
// 2026-08-30, first-callback eyeball): when the tech-reviewed AI report owns
// the summary, the payload drops the "What we found & did" tiles
// (typedReport.findings), the "What we recommend" list, and the lawn program
// explainer — the prose already tells that story, on web and PDF alike.
// Suppression requires ALL of: gate on, callback record, lawn line, and the
// technician_report summary source — any miss keeps every card.

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
  'The lawn is recovering, though weed and gray leaf spot pressure stayed active. Hold off on any irrigation for at least 48 hours so the product is not washed away.',
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
