const { treeShrubFieldGuide } = require('../services/tree-shrub-field-guide');
const { treeShrubDueReason } = require('../services/tree-shrub-completion-defaults');
const { tree_shrub: program } = require('../config/protocols.json');
const visit = month => program.visits.find(row => row.month === month);
afterEach(() => { delete process.env.GATE_TREE_SHRUB_FIELD_GUIDE; });

test('dark guide stays off; scheduled month projects only its own product details and equipment', () => {
  expect(treeShrubFieldGuide(visit('Jan'))).toBeNull();
  process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
  const january = treeShrubFieldGuide(visit('Jan'));
  expect(january.products.snapshot.equipment).toEqual(['hand', 'push']);
  expect(january.products.merit.equipment).toEqual(['soil']);
  expect(january.products.talus).toBeUndefined();
  const september = treeShrubFieldGuide(visit('Sep'));
  expect(september.products.snapshot).toBeUndefined();
  expect(september.products.talus.mix).toBeUndefined();
  expect(september.products.talus.pending).toMatch(/prohibited/);
});

const application = (product_name, date, overrides = {}) => ({ product_name, application_date: date, property_id: 'property-a', rate_unit: 'lb', application_rate: 2.3, ...overrides });
test('Snapshot respects property, recent applications, rolling limits and unknown history units', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  expect(due([])).toBeNull();
  expect(due([application('Snapshot 2.5TG', '2028-06-01')])).toMatch(/60 days/);
  expect(due([application('Snapshot 2.5TG', '2028-06-01', { property_id: 'property-b' })])).toBeNull();
  expect(due([application('Snapshot 2.5TG', '2028-04-01', { property_id: null })])).toMatch(/unconfirmed property/);
  expect(due([application('Snapshot 2.5TG', '2028-04-01', { rate_unit: 'oz' })])).toMatch(/prior Snapshot rates/);
  expect(due(['2027-10-01', '2028-01-01', '2028-04-01'].map(date => application('Snapshot 2.5TG', date, { application_rate: 3.45 })))).toMatch(/annual limit/);
  expect(due([application('Snapshot 2.5TG', '2028-07-01')])).toMatch(/already recorded/);
  for (const date of [null, '', 'invalid', new Date(NaN)]) {
    expect(due([application('Snapshot 2.5TG', date)])).toMatch(/unconfirmed property or date/);
    expect(treeShrubDueReason('snapshot', [], date, 'property-a')).toMatch(/visit date/);
  }
});

test('both palm fertilizers and the old palm product share one three-month/four-feeding history', () => {
  const history = [application('8-2-12 palm fertilizer', '2028-04-30')];
  expect(treeShrubDueReason('f0016', history, '2028-07-29', 'property-a')).toMatch(/three months/);
  expect(treeShrubDueReason('f0016', history, '2028-07-30', 'property-a')).toBeNull();
  const four = ['2027-10-01', '2028-01-01', '2028-04-01', '2028-07-01'].map(date => application('LESCO 0-0-16', date));
  expect(treeShrubDueReason('f8012', four, '2028-09-30', 'property-a')).toMatch(/Four applications/);
  expect(treeShrubDueReason('f8012', [], '2028-10-01', null)).toMatch(/Confirm the service property/);
});
