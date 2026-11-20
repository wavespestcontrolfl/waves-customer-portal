/**
 * The report's dynamic context (the AI summary card, the premium cards, the
 * pressure trend and the since-last-visit line) and the report writer's
 * prior-visit grounding show only the service_findings rows a customer may
 * see (finding-provenance.js). Completion saves the form's free-text
 * observations as rows with a bare title, a [Found] line of the raw
 * technician note among them; the report document, the texting prompt and
 * the voice relay already drop those rows, and these readers printed them.
 */
const { provenFindingRows } = require('../services/service-report/finding-provenance');
const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');
const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

const RECORD_ID = 'svc-proven-findings';
const PRIOR_ID = 'svc-proven-prior';
const row = (id, title, extra = {}) => ({
  id, service_record_id: RECORD_ID, zone_id: null, category: 'observation', severity: 'high', title, detail: null, recommendation: null, ...extra,
});
// This visit: a [Found] line of the raw note saved as a bare title (the
// highest severity, so an unfiltered reader leads with it), a finding with
// its own detail, and an older row that stored the picked form label bare.
// The prior visit: its own bare raw title, a detailed finding, a bare label
// only its own snapshot lists (kept, and its main driver) and a bare label
// only this visit's snapshot lists (dropped: each visit proves its own rows).
const RAW = row('f-raw', 'Gate code 4471 by the side door', { severity: 'critical' });
const DETAILED = row('f-detail', 'Ant trail at the slab', { detail: 'A trail along the north wall.', recommendation: 'Keep mulch back from the slab.' });
const FORM_LABEL = row('f-form', 'Yellowjacket');
const PRIOR_RAW = row('p-raw', 'Lockbox 2210 under the mat', { service_record_id: PRIOR_ID, severity: 'critical' });
const PRIOR_DETAILED = row('p-detail', 'Roach activity in the garage', { service_record_id: PRIOR_ID, detail: 'Two adults under the water heater.' });
const PRIOR_OWN_LABEL = row('p-own', 'Fire ant mounds', { service_record_id: PRIOR_ID, severity: 'critical' });
const PRIOR_OTHER_LABEL = row('p-other', 'Paper wasp nest', { service_record_id: PRIOR_ID, severity: 'medium' });
const BARE_TEXT = /4471|side door|2210|Lockbox|Paper wasp/;
// The technician's own note (report-note-render.test.js): its record's form
// labels pass the customer-copy screen before they prove a row.
const NOTE_RECORD = { reportNote: { v: 1, text: 'I treated the perimeter and swept the webs.', source: 'cleaned' } };

const visit = (id, date, pressure, notes) => ({
  id, customer_id: 'cust-proven', service_line: 'pest', service_type: 'Quarterly Pest Control Service', status: 'completed',
  service_date: date, started_at: `${date}T14:00:00Z`, pressure_index: pressure, structured_notes: notes,
});
// Both readings before the 2026-09-24 scale cutover, so the trend compares them.
const TABLES = {
  service_records: [
    visit(RECORD_ID, '2026-09-10', 2.5, JSON.stringify({ formObservations: ['Yellowjacket', 'Paper wasp nest'], observations: ['Yellowjacket', RAW.title] })),
    visit(PRIOR_ID, '2026-07-10', 3.1, { formObservations: ['Fire ant mounds'] }),
  ],
  service_findings: [RAW, DETAILED, FORM_LABEL, PRIOR_RAW, PRIOR_DETAILED, PRIOR_OWN_LABEL, PRIOR_OTHER_LABEL],
};

// Each query resolves its table's rows; plain-object, two-argument,
// whereNot, whereIn and whereNotNull filters apply ("table.column" keys too).
function fakeKnex(tables) {
  const knex = (table) => {
    let rows = [...(tables[table] || [])];
    const col = (key) => String(key).split('.').pop();
    const matches = (r, criteria) => Object.entries(criteria).every(([k, v]) => r[col(k)] === v);
    const q = new Proxy(() => q, {
      get(_, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        if (prop === 'catch') return () => Promise.resolve(rows);
        if (prop === 'first') return () => Promise.resolve(rows[0] || null);
        if (prop === 'columnInfo') return () => Promise.resolve({});
        if (prop === 'where') {
          return (a, ...rest) => {
            if (a && typeof a === 'object') rows = rows.filter((r) => matches(r, a));
            else if (typeof a === 'string' && rest.length === 1) rows = rows.filter((r) => r[col(a)] === rest[0]);
            return q;
          };
        }
        if (prop === 'whereNot') return (a) => { rows = rows.filter((r) => !matches(r, a)); return q; };
        if (prop === 'whereIn') return (k, vals) => { rows = rows.filter((r) => vals.includes(r[col(k)])); return q; };
        if (prop === 'whereNotNull') return (k) => { rows = rows.filter((r) => r[col(k)] != null); return q; };
        return () => q;
      },
    });
    return q;
  };
  knex.raw = (sql) => sql;
  knex.fn = { now: () => new Date() };
  return knex;
}

describe('provenFindingRows', () => {
  test('keeps a row with a detail or a recommendation, or a title the form snapshot lists', () => {
    const rows = [RAW, DETAILED, row('f-rec', 'Mulch on the slab', { recommendation: 'Pull mulch back.' }), FORM_LABEL];
    expect(provenFindingRows(rows, { formObservations: [' yellowjacket '] }).map((r) => r.id)).toEqual(['f-detail', 'f-rec', 'f-form']);
    expect(provenFindingRows(rows, JSON.stringify({ formObservations: ['Yellowjacket'] })).map((r) => r.id)).toEqual(['f-detail', 'f-rec', 'f-form']);
    // Stored notes that cannot be read prove no label.
    expect(provenFindingRows(rows, '{"formObservations":').map((r) => r.id)).toEqual(['f-detail', 'f-rec']);
    expect(provenFindingRows(rows, null).map((r) => r.id)).toEqual(['f-detail', 'f-rec']);
    expect(provenFindingRows(null, {})).toEqual([]);
  });

  test("on a record that carries the technician's own note, a label proves a row only when it passes the customer-copy screen", () => {
    const formObservations = ['Yellowjacket', RAW.title];
    expect(provenFindingRows([RAW, FORM_LABEL], { formObservations }).map((r) => r.id)).toEqual(['f-raw', 'f-form']);
    expect(provenFindingRows([RAW, FORM_LABEL], { ...NOTE_RECORD, formObservations }).map((r) => r.id)).toEqual(['f-form']);
    expect(provenFindingRows([RAW, FORM_LABEL], JSON.stringify({ ...NOTE_RECORD, formObservations })).map((r) => r.id)).toEqual(['f-form']);
  });
});

describe('customer readers of a visit\'s findings', () => {
  test('the dynamic context the report sends, pressure on, never prints a bare title of this visit or the prior one', async () => {
    const context = await buildServiceReportDynamicContext({ recordId: RECORD_ID, omitPestPressureContext: false, knex: fakeKnex(TABLES) });
    // Every reader ran on the rows a customer may see.
    expect(JSON.stringify(context.aiSummary)).toContain('Ant trail at the slab');
    expect(JSON.stringify(context.aiSummary)).toContain('Yellowjacket');
    expect(JSON.stringify(context.premiumExperience)).toContain('Ant trail at the slab');
    const priorPoint = context.pressureTrend.points.find((point) => point.serviceRecordId === PRIOR_ID);
    expect(priorPoint).toMatchObject({ mainDriver: 'Fire ant mounds', findingsCount: 2 });
    expect(context.sinceLastVisit.activityLine).toContain('Ant trail at the slab');
    expect(JSON.stringify(context)).not.toMatch(BARE_TEXT);
  });

  test("on a note record, a form label the customer-copy screen refuses never prints", async () => {
    // The form snapshot lists the access code too; the record's report lists
    // drop it (report-data buildProtocolPayload), and so does every reader here.
    const notes = JSON.stringify({ ...NOTE_RECORD, formObservations: ['Yellowjacket', RAW.title] });
    const tables = { ...TABLES, service_records: [{ ...TABLES.service_records[0], structured_notes: notes }, TABLES.service_records[1]] };
    const context = await buildServiceReportDynamicContext({ recordId: RECORD_ID, omitPestPressureContext: false, knex: fakeKnex(tables) });
    expect(JSON.stringify(context.aiSummary)).toContain('Yellowjacket');
    expect(context.sinceLastVisit.activityLine).toContain('Ant trail at the slab');
    expect(JSON.stringify(context)).not.toMatch(BARE_TEXT);
  });

  test("the report writer's prior-visit grounding never carries a bare title", async () => {
    const copy = await buildReportCopyContext({
      customerId: 'cust-proven', serviceType: 'Quarterly Pest Control Service', serviceLine: 'pest', serviceDate: '2026-11-20', knex: fakeKnex(TABLES),
    });
    const priorLine = copy.contextText.split('\n').find((line) => line.startsWith('Earlier ('));
    expect(priorLine).toContain('Roach activity in the garage');
    expect(priorLine).toContain('Fire ant mounds');
    expect(JSON.stringify(copy)).not.toMatch(BARE_TEXT);
  });
});
