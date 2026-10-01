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

function stubKnex(fixtures = {}) {
  return (table) => {
    const rows = fixtures[table] || [];
    const query = {
      where: () => query,
      whereIn: () => query,
      whereNot: () => query,
      whereNotIn: () => query,
      andWhere: () => query,
      orderBy: () => query,
      modify: () => query,
      limit: () => query,
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
}

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

describe('four-section report in the report payload', () => {
  test('rides as reportSections, with the same-service next visit in the live view', async () => {
    const data = await buildReportV1Data(serviceRow(FOUR_SECTIONS), 'token-four-section', stubKnex({
      scheduled_services: [{
        id: 'next-1', customer_id: 'customer-1', service_type: 'Quarterly Pest Control',
        scheduled_date: '2099-01-05', window_start: '09:00:00', status: 'confirmed',
      }],
    }), { mode: 'live' });
    expect(data.summarySource).toBe('technician_report');
    expect(data.reportSections.map((section) => section.key)).toEqual(['whatWeFound', 'whatWeDid', 'whatToExpect', 'whatsNext']);
    expect(data.summary).toBe(data.reportSections.map((section) => section.paragraphs.join(' ')).join(' '));
    expect(data.nextSameServiceAppointment).toEqual(expect.objectContaining({ serviceType: 'Quarterly Pest Control', scheduledDate: '2099-01-05' }));
  });

  test('a two-section paragraph carries neither field', async () => {
    const data = await buildReportV1Data(serviceRow(TWO_SECTIONS), 'token-two-section', stubKnex(), { mode: 'live' });
    expect(data.summarySource).toBe('technician_report');
    expect(data).not.toHaveProperty('reportSections');
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
  });

  test('every non-live render drops the next visit, like nextAppointment', () => {
    const data = { nextAppointment: { scheduledDate: '2099-01-05' }, nextSameServiceAppointment: { scheduledDate: '2099-01-05' }, reportSections: [] };
    stripLiveOnlyScheduleFields(data);
    expect(data).not.toHaveProperty('nextSameServiceAppointment');
    expect(data).not.toHaveProperty('nextAppointment');
    expect(data).toHaveProperty('reportSections');
  });
});
