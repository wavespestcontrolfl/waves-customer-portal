/**
 * The four-section report (GATE_REPORT_WRITER_RULES) as the report payload's
 * summary: its screened sections ride as `reportSections`, and the next visit
 * on the report's own service line as `nextSameServiceAppointment` (live view
 * only). A two-section paragraph carries neither.
 */
jest.mock('../services/service-report/rodent-report-narrative', () => ({
  applyRodentReportNarrative: jest.fn(async () => null),
  applyTypedReportNarrative: jest.fn(async () => null),
}));

const { buildReportV1Data, stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');

// first() answers with a table's first row (the report's own visit);
// whereNot('id', x) leaves that row out of a list.
function stubKnex(fixtures = {}) {
  return (table) => {
    let excluded = null;
    const rows = () => (fixtures[table] || []).filter((row) => row.id !== excluded);
    const query = {
      where: () => query,
      whereIn: () => query,
      whereNot: (col, val) => { excluded = typeof col === 'object' ? col.id : val; return query; },
      whereNotIn: () => query,
      andWhere: () => query,
      orderBy: () => query,
      modify: (fn) => { fn(query); return query; },
      limit: () => query,
      select: () => Promise.resolve(rows()),
      first: () => Promise.resolve((fixtures[table] || [])[0] || null),
      catch: () => Promise.resolve(rows()),
      then: (resolve) => Promise.resolve(rows()).then(resolve),
    };
    return query;
  };
}

const HOME = { service_address_line1: '123 Main St', service_address_city: 'Bradenton', service_address_zip: '34209' };
const RENTAL = { service_address_line1: '456 Oak Ave', service_address_city: 'Bradenton', service_address_zip: '34209' };
const REPORT_VISIT = { id: 'visit-1', customer_id: 'customer-1', service_type: 'Pest Re-Service', scheduled_date: '2026-09-30', status: 'completed', ...HOME };

const FOUR_SECTIONS = [
  'WHAT WE FOUND', 'Ghost ants were trailing along the slider track.',
  'WHAT WE DID AND WHY', 'We placed bait along the counter, because ants carry it back to the colony.',
  'WHAT TO EXPECT', 'You may see a few more ants for a few days.',
  "WHAT'S NEXT", 'Let us know if they keep trailing after about 1–2 weeks.',
].join('\n');
const TWO_SECTIONS = ['WHAT WE DID', 'We treated the slider track.', 'WHAT WE FOUND', 'Ghost ants were trailing along it.'].join('\n');

function serviceRow(notes) {
  return {
    id: 'service-four-section-1',
    customer_id: 'customer-1',
    scheduled_service_id: 'visit-1',
    service_line: 'pest',
    service_type: 'Pest Re-Service',
    service_date: '2026-09-30',
    first_name: 'Pat',
    last_name: 'Customer',
    areas_serviced: '[]',
    structured_notes: '{}',
    technician_notes: notes,
    pressure_index: null,
    service_data: '{}',
  };
}

const ORIGINAL_GATE = process.env.GATE_REPORT_WRITER_RULES;
beforeEach(() => { process.env.GATE_REPORT_WRITER_RULES = 'true'; });
afterEach(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
  else process.env.GATE_REPORT_WRITER_RULES = ORIGINAL_GATE;
});

describe('four-section report in the report payload', () => {
  test('with the writer switch off a four-section note is not the summary and adds no fields', async () => {
    delete process.env.GATE_REPORT_WRITER_RULES;
    const data = await buildReportV1Data(serviceRow(FOUR_SECTIONS), 'token-four-section-off', stubKnex({
      scheduled_services: [REPORT_VISIT],
    }), { mode: 'live' });
    expect(data.summarySource).not.toBe('technician_report');
    expect(data).not.toHaveProperty('reportSections');
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
  });

  test('rides as reportSections, with the same-service next visit in the live view', async () => {
    const data = await buildReportV1Data(serviceRow(FOUR_SECTIONS), 'token-four-section', stubKnex({
      scheduled_services: [REPORT_VISIT, {
        id: 'next-1', customer_id: 'customer-1', service_type: 'Quarterly Pest Control',
        scheduled_date: '2099-01-05', window_start: '09:00:00', status: 'confirmed', ...HOME,
      }],
    }), { mode: 'live' });
    expect(data.summarySource).toBe('technician_report');
    expect(data.reportSections.map((section) => section.key)).toEqual(['whatWeFound', 'whatWeDid', 'whatToExpect', 'whatsNext']);
    expect(data.summary).toBe(data.reportSections.map((section) => section.paragraphs.join(' ')).join(' '));
    expect(data.nextSameServiceAppointment).toEqual(expect.objectContaining({ serviceType: 'Quarterly Pest Control', scheduledDate: '2099-01-05' }));
  });

  test("a booking at another of the customer's properties is not this report's next visit", async () => {
    const data = await buildReportV1Data(serviceRow(FOUR_SECTIONS), 'token-four-section-rental', stubKnex({
      scheduled_services: [REPORT_VISIT, {
        id: 'next-1', customer_id: 'customer-1', service_type: 'Quarterly Pest Control',
        scheduled_date: '2099-01-05', window_start: '09:00:00', status: 'confirmed', ...RENTAL,
      }],
    }), { mode: 'live' });
    expect(data.reportSections).toHaveLength(4);
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
  });

  test('a two-section paragraph carries neither field', async () => {
    const data = await buildReportV1Data(serviceRow(TWO_SECTIONS), 'token-two-section', stubKnex(), { mode: 'live' });
    expect(data.summarySource).toBe('technician_report');
    expect(data).not.toHaveProperty('reportSections');
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
  });

  test('a PDF render never looks up the next visit (live view only)', async () => {
    const firsts = [];
    const knex = stubKnex({ scheduled_services: [REPORT_VISIT] });
    const spying = (table) => {
      const query = knex(table);
      const first = query.first;
      query.first = (...cols) => { firsts.push([table, cols]); return first(...cols); };
      return query;
    };
    await buildReportV1Data(serviceRow(FOUR_SECTIONS), 'token-four-section-pdf', spying, { mode: 'pdf' });
    expect(firsts.some(([table, cols]) => table === 'scheduled_services' && cols.includes('service_address_line1'))).toBe(false);
  });

  test('a frozen four-section card body shows with the switch on and hides with it off', async () => {
    const row = {
      ...serviceRow('WHAT WE DID\nWe treated.\nWHAT WE FOUND\nAnts.'),
      service_data: JSON.stringify({
        typedReportSnapshot: {
          type: 'one_time_pest', typeLabel: 'One-Time Pest', serviceLabel: 'One-Time Pest', schemaVersion: 2, visitSequence: 1,
          values: { target_pest: 'Ants' }, findings: [], nextStepChips: [],
          todaysResult: { headline: 'Service completed.', body: 'Ghost ants were trailing. We placed bait.', bodySource: 'technician_report', bodyFormat: 'four_section' },
        },
      }),
    };
    const on = await buildReportV1Data(row, 'token-frozen-on', stubKnex(), { mode: 'live' });
    expect(on.typedReport.todaysResult.body).toBe('Ghost ants were trailing. We placed bait.');
    delete process.env.GATE_REPORT_WRITER_RULES;
    const off = await buildReportV1Data(row, 'token-frozen-off', stubKnex(), { mode: 'live' });
    expect(off.typedReport.todaysResult.headline).toBe('Service completed.');
    expect(off.typedReport.todaysResult).not.toHaveProperty('body');
  });

  test('every non-live render drops the next visit, like nextAppointment', () => {
    const data = { nextAppointment: { scheduledDate: '2099-01-05' }, nextSameServiceAppointment: { scheduledDate: '2099-01-05' }, reportSections: [] };
    stripLiveOnlyScheduleFields(data);
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
    expect(data).not.toHaveProperty('nextAppointment');
    expect(data).toHaveProperty('reportSections');
  });
});
