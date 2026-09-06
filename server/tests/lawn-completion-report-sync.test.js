const { LAWN_STRUCTURED_OBSERVATIONS } = require('../../shared/lawn-condition-findings');
const library = require('../../shared/lawn-condition-findings.json');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { freezeTechTips } = require('../services/service-report/tip-library');

const finding = 'Leaf spotting consistent with gray leaf spot was observed. Location: Back yard. Extent: Isolated spot.';

test('the lawn customer vocabulary accepts controlled selections and rejects appended or invented claims', () => {
  expect(LAWN_STRUCTURED_OBSERVATIONS.has(finding)).toBe(true);
  expect(LAWN_STRUCTURED_OBSERVATIONS.has(`${finding} Fungicide applied.`)).toBe(false);
  expect(LAWN_STRUCTURED_OBSERVATIONS.has('Gray leaf spot confirmed. Location: Back yard.')).toBe(false);
  expect(LAWN_STRUCTURED_OBSERVATIONS.has('Leaf spotting consistent with gray leaf spot was observed. Location: Gate code 1234.')).toBe(false);
  expect(LAWN_STRUCTURED_OBSERVATIONS.size).toBe(library.groups.reduce((n, g) => n + g.findings.length, 0) * library.locations.length * (library.extents.length + 1));
});

test('the customer payload preserves submitted lawn findings, work, quantities and areas without publishing internal notes as findings', async () => {
  const rows = {
    service_products: [{ id: 'test-application', product_id: 'test-product', product_name: 'Test potassium', product_category: 'fertilizer', application_rate: 3, rate_unit: 'fl_oz', total_amount: 12, amount_unit: 'fl_oz', application_method: 'broadcast_spray', application_area: 'Front yard, Side yards', area_value: 4000, area_unit: 'sqft' }],
  };
  const knex = (table) => {
    const result = rows[table] || [];
    const query = {};
    for (const method of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere', 'orWhere', 'orderBy', 'select', 'leftJoin', 'join', 'limit']) query[method] = () => query;
    query.first = async () => result[0] || null;
    query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    query.catch = (reject) => Promise.resolve(result).catch(reject);
    return query;
  };
  knex.schema = { hasTable: async () => false, hasColumn: async () => false };
  const tips = freezeTechTips({ ids: [], custom: 'Monitor the affected patch and contact us if it spreads.' }).tips;
  const data = await buildReportV1Data({
    id: 'test-lawn-record', customer_id: 'test-property', service_line: 'lawn', service_type: 'Every 6 Weeks Lawn Care Service', service_date: '2026-09-05', status: 'completed',
    areas_serviced: ['Front yard', 'Side yards'], technician_notes: '[Found] Internal access instruction',
    structured_notes: { formObservations: [finding], observations: [finding, 'Internal access instruction'], protocolActionsCompleted: ['Tested irrigation coverage'], techTips: tips },
    service_data: {},
  }, 'test-preview-token', knex);
  expect(data.protocol.structuredObservations).toEqual([finding]);
  expect(data.protocol.actions).toContain('Tested irrigation coverage');
  expect(data.findings.map((item) => item.title)).toContain(finding);
  expect(data.findings.map((item) => item.title).join(' ')).not.toContain('Internal access');
  expect(data.applications[0]).toMatchObject({ rate: 3, totalAmount: 12, areaValue: 4000, applicationArea: 'Front yard, Side yards' });
  expect(data.protocol.techTips).toEqual(tips);
});
