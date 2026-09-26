/**
 * aiProposeVendorMappings (price-sync/auto-map's AI research pass) — Codex
 * r10 on #4884: the old check only looked at `mappings.length` — a non-empty
 * array of garbage entries (`{"mappings":[{}]}`, or entries whose productId
 * isn't among the requested products) passed it, even though the lookup at
 * the route's apply loop (`proposals.find(p => p.productId === product.id)`)
 * resolves to nothing for every one of them — functionally identical to an
 * empty batch, but recorded a ledger success. Fixed: a nonempty `mappings`
 * array with NOT ONE usable entry (a recognized productId + a boolean
 * `found`) is now a ledger failure.
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

function fakeAnthropic(text) {
  return { messages: { create: jest.fn(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })) } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('an entirely garbage nonempty batch ({"mappings":[{}]}) is a ledger failure', async () => {
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [{}] }));
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toHaveLength(1); // parseAutoMapResponse still returns it — the route's lookup finds nothing
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('every entry naming a productId outside the requested batch is a ledger failure', async () => {
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [{ productId: 'not-in-batch', found: false }] }));
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toHaveLength(1);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('a `found` that is not a strict boolean (e.g. the string "false") makes the entry unusable', async () => {
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [{ productId: 'p1', found: 'false' }] }));
  await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('at least one usable entry (recognized productId + boolean found) is not flagged, even if another entry in the same batch is garbage', async () => {
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [{}, { productId: 'p1', found: true, vendorSku: 'SO-1' }] }));
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toHaveLength(2);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('a genuinely partial batch — usable entries for only SOME requested products — is not itself a ledger failure (the omitted product just stays retryable)', async () => {
  // Only p1 gets a decision; p2 is omitted entirely from the model's answer.
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [{ productId: 'p1', found: false, notes: 'no match' }] }));
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toHaveLength(1);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('an empty mappings array ({"mappings":[]}) is the PRE-EXISTING invalid_json path, unrelated to this fix — every requested product still needs a decision', async () => {
  const anthropic = fakeAnthropic(JSON.stringify({ mappings: [] }));
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toEqual([]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_json');
});

test('unparseable text is still the pre-existing invalid_json failure', async () => {
  const anthropic = fakeAnthropic('not json at all');
  const mappings = await aiProposeVendorMappings(anthropic, VENDOR, PRODUCTS);
  expect(mappings).toEqual([]);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_json');
});
