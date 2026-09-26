/**
 * aiProposeVendorMappings (price-sync/auto-map's AI research pass).
 *
 * The route persists an inactive "no match" marker for every product that has
 * a proposal, which drops the product from every later batch. So the function
 * returns ONLY real decisions — a productId from this batch, a boolean `found`
 * and, when found, an identifier — and a malformed entry leaves its product
 * retryable (Codex r13 on #4884; r10 had only flagged an all-garbage batch and
 * still returned the unfiltered list). The ledger row fails unless the model
 * finished and every requested product got a decision.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const inventoryRouter = require('../routes/admin-inventory');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');
const { aiProposeVendorMappings } = inventoryRouter._test;

const VENDOR = { id: 'v-acme', name: 'Acme Supply', website: 'acme.example' };
const PRODUCTS = [
  { id: 'p1', name: 'Termidor SC', category: 'termiticide', sku: null, container_size: '20oz', epa_reg_number: '7969-210' },
  { id: 'p2', name: 'Taurus SC', category: 'termiticide', sku: null, container_size: '78oz', epa_reg_number: '279-9573' },
];
const P1_FOUND = { productId: 'p1', found: true, vendorSku: 'SO-1' };
const P2_NONE = { productId: 'p2', found: false, notes: 'no match' };

function fakeAnthropic(text) {
  return { messages: { create: jest.fn(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })) } };
}
const propose = (mappings) => aiProposeVendorMappings(fakeAnthropic(JSON.stringify({ mappings })), VENDOR, PRODUCTS);

beforeEach(() => {
  jest.clearAllMocks();
});

test('a decision for every requested product is returned whole and not flagged', async () => {
  expect(await propose([P1_FOUND, P2_NONE])).toEqual([P1_FOUND, P2_NONE]);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('the r13 case: a malformed member ({"productId":"p2"}) is dropped — p2 gets no proposal and stays retryable — and the row fails', async () => {
  expect(await propose([P1_FOUND, { productId: 'p2' }])).toEqual([P1_FOUND]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test.each([
  ['an empty object', {}],
  ['a productId outside the batch', { productId: 'not-in-batch', found: false }],
  ['a string "false" found', { productId: 'p2', found: 'false' }],
  ['found:true with no identifier', { productId: 'p2', found: true }],
  ['found:true with the word "null" as its SKU', { productId: 'p2', found: true, vendorSku: 'null', productUrl: null }],
  ['found:true with an object SKU', { productId: 'p2', found: true, vendorSku: { id: 1 } }],
  ['found:true with a non-http URL', { productId: 'p2', found: true, productUrl: 'javascript:alert(1)' }],
])('%s is not a decision: dropped, and the row fails', async (_label, entry) => {
  expect(await propose([P1_FOUND, entry])).toEqual([P1_FOUND]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('an http(s) URL or a numeric SKU is an identifier', async () => {
  const byUrl = { productId: 'p2', found: true, productUrl: 'https://acme.example/taurus-sc-78oz' };
  const bySku = { productId: 'p2', found: true, vendorSku: 12345 };
  expect(await propose([P1_FOUND, byUrl])).toEqual([P1_FOUND, byUrl]);
  expect(await propose([P1_FOUND, bySku])).toEqual([P1_FOUND, bySku]);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('a product the model omitted stays retryable (no proposal), and the partial answer fails the row', async () => {
  expect(await propose([P1_FOUND])).toEqual([P1_FOUND]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('an empty mappings array or unparseable text is invalid_json; an empty reply is empty_text', async () => {
  expect(await propose([])).toEqual([]);
  expect(ledgerCallRejected).toHaveBeenLastCalledWith(expect.anything(), 'invalid_json');
  expect(await aiProposeVendorMappings(fakeAnthropic('not json at all'), VENDOR, PRODUCTS)).toEqual([]);
  expect(ledgerCallRejected).toHaveBeenLastCalledWith(expect.anything(), 'invalid_json');
  expect(await aiProposeVendorMappings(fakeAnthropic(''), VENDOR, PRODUCTS)).toEqual([]);
  expect(ledgerCallRejected).toHaveBeenLastCalledWith(expect.anything(), 'empty_text');
});

test('a tool loop that runs out before a final answer fails the row', async () => {
  const anthropic = {
    messages: {
      create: jest.fn(async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: {} }] })),
    },
  };
  expect(await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS)).toEqual([]);
  expect(anthropic.messages.create).toHaveBeenCalledTimes(13); // first call + 12 loop turns
  expect(ledgerCallRejected).toHaveBeenCalledTimes(1);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'tool_loop_exhausted');
});

// Review on #4884: fields the route writes must be on-contract when present.
test.each([
  ['a word confidence (stored as the 0.50 default)', { confidence: 'high' }],
  ['an out-of-range confidence (fails applyMappingRow after acceptance)', { confidence: -1 }],
  ['an object price (notes "~$[object Object]")', { price: { usd: 99 } }],
  ['an object product name', { vendorProductName: {} }],
  ['an object package unit', { packageSizeUnit: {} }],
  ['object notes', { notes: { why: 'x' } }],
])('%s makes the decision unusable: dropped, and the row fails', async (_label, extra) => {
  expect(await propose([P1_FOUND, { ...P2_NONE, ...extra }])).toEqual([P1_FOUND]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('in-contract optional fields are accepted', async () => {
  const full = { productId: 'p2', found: true, vendorSku: 'TS-78', productUrl: 'https://acme.example/taurus', vendorProductName: 'Taurus SC 78oz', packageSizeValue: 78, packageSizeUnit: 'oz', purchaseUom: 'each', price: '129.99', confidence: 0.9, notes: 'exact match' };
  expect(await propose([P1_FOUND, full])).toEqual([P1_FOUND, full]);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

// Codex r20 on #4884: distributor_product_map column limits.
test.each([
  ['a SKU over distributor_sku varchar(100)', { vendorSku: 'S'.repeat(101) }],
  ['a unit over package_size_unit varchar(30)', { packageSizeUnit: 'u'.repeat(31) }],
  ['a purchase UOM over varchar(30)', { purchaseUom: 'e'.repeat(31) }],
  ['a package size past decimal(12,4)', { packageSizeValue: 1e9 }],
])('%s makes the decision unusable: dropped, and the row fails', async (_label, extra) => {
  expect(await propose([P1_FOUND, { productId: 'p2', found: true, vendorSku: 'TS-78', ...extra }])).toEqual([P1_FOUND]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('a non-numeric package size ("32 oz") is kept, stored as no size as before', async () => {
  const entry = { productId: 'p2', found: true, vendorSku: 'TS-78', packageSizeValue: '32 oz' };
  expect(await propose([P1_FOUND, entry])).toEqual([P1_FOUND, entry]);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});
