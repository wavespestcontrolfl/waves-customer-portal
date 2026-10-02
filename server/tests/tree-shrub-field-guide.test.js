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

test('lawn winterizer does not count as a palm feeding but the confirmed palm SKU does', () => {
  expect(treeShrubDueReason('f0016', [application('0-0-16 Winterizer', '2028-09-01')], '2028-10-01', 'property-a')).toBeNull();
  expect(treeShrubDueReason('f0016', [application('LESCO 0-0-16 Winterizer', '2028-09-01')], '2028-10-01', 'property-a')).toBeNull();
  expect(treeShrubDueReason('f8012', [application('LESCO 0-0-16 #510513', '2028-09-01')], '2028-10-01', 'property-a')).toMatch(/three months/);
});

test('Fast Complete Snapshot rows (total, no rate) count toward the annual limit instead of blocking', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  const fast = (date, overrides = {}) => application('Snapshot 2.5TG', date, { application_rate: null, rate_unit: null, total_amount: 25.5, amount_unit: 'lb', ...overrides });
  // One earlier-quarter row with no area reserves the label max (4.6) and leaves room.
  expect(due([fast('2028-04-01')])).toBeNull();
  // Two reserved rows plus the next max-rate pass exceed the rolling limit.
  expect(due([fast('2027-10-01'), fast('2028-01-01')])).toMatch(/annual limit/);
  // With the bed area recorded, the rate is derived: 25.5 lb over 11,000 sq ft = 2.32.
  expect(due([fast('2027-10-01', { area_value: 11000, area_unit: 'sqft' }), fast('2028-01-01', { area_value: 11000, area_unit: 'sqft' })])).toBeNull();
  // Neither a rate nor an amount: still unreviewable.
  expect(due([fast('2028-04-01', { total_amount: null })])).toMatch(/prior Snapshot rates/);
  expect(due([fast('2028-04-01', { amount_unit: 'fl oz' })])).toMatch(/prior Snapshot rates/);
});

test('palm spacing is one three-calendar-month rule shared with Fast Complete', () => {
  const { palmFeedingTooSoon } = require('../services/tree-shrub-completion-defaults');
  const { buildTreeShrubWarnings } = require('../services/tree-shrub-fast-context');
  // 2028-04-30 → three months later is 2028-07-30; day 80 is still too soon.
  expect(palmFeedingTooSoon('2028-04-30', '2028-07-19')).toBe(true);
  expect(palmFeedingTooSoon('2028-04-30', '2028-07-30')).toBe(false);
  const palm = { id: 'palm', name: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)', category: 'fertilizer' };
  const applications = [{ application_date: '2028-04-30', product_id: 'palm', product_name: palm.name, category: 'fertilizer' }];
  const warn = date => buildTreeShrubWarnings({ catalogRows: [palm], applications, visitDate: date }).filter(w => w.type === 'palm_fertilizer_spacing');
  expect(warn('2028-07-19')).toHaveLength(1);
  expect(warn('2028-07-30')).toHaveLength(0);
});
