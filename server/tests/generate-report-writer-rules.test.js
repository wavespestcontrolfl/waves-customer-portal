// GATE_REPORT_WRITER_RULES at the route (owner "go" 2026-09-30): pest and
// the remaining specialty writers get the owner rules, product names and
// rates stay out of the prompt, customer messages arrive labeled and
// scrubbed, and the output screen rejects what the rules forbid. Lawn and
// tree/shrub/palm must reach the model byte-identical (owner: another lane
// owns them). Mirrors the handler harness in
// generate-report-photo-content.test.js.
let mockProfile = { serviceKey: 'pest_general_quarterly', findingsType: null };
let mockServiceType = 'Quarterly Pest Control Service';
let mockCatalogRows = [];
let mockCatalogFails = false;
let mockAliasRows = [];
let mockBooked = {};
const mockProvider = jest.fn();
const mockBuildContext = jest.fn(async () => ({ contextText: '', signals: {} }));
const mockComms = jest.fn(async () => ({ text: '', promptHint: '' }));
const mockCustomerWords = jest.fn(async () => ({ text: '', promptHint: '' }));
const mockResolveMarks = jest.fn(async () => []);
jest.mock('../services/service-report/visit-promises', () => ({
  ...jest.requireActual('../services/service-report/visit-promises'),
  resolveVisitPromiseMarks: (...args) => mockResolveMarks(...args),
}));
jest.mock('../services/llm/call', () => ({ callOpenAI: (...args) => mockProvider(...args), callAnthropic: (...args) => mockProvider(...args) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));
jest.mock('../services/service-report/report-copy-context', () => ({ buildReportCopyContext: (...args) => mockBuildContext(...args) }));
jest.mock('../services/completion-comms-context', () => ({
  buildCompletionCommsContext: (...args) => mockComms(...args),
  buildCustomerWordsContext: (...args) => mockCustomerWords(...args),
  scrubCustomerText: jest.requireActual('../services/completion-comms-context').scrubCustomerText,
}));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const chain = {};
    // The visit's own product lookup filters the catalog by id or name
    // (a callback where); the prompt scan reads every row.
    let match = null;
    for (const name of ['whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) chain[name] = () => chain;
    chain.where = (arg) => {
      if (typeof arg === 'function') {
        const sets = [];
        const q = {
          whereIn: (col, vals) => { sets.push([col, vals]); return q; },
          orWhereIn: (col, vals) => { sets.push([col, vals]); return q; },
        };
        arg(q);
        match = (row) => sets.some(([col, vals]) => vals.includes(row[col]));
      }
      return chain;
    };
    chain.first = async () => (table === 'scheduled_services'
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: mockServiceType, customer_id: 'customer-1', ...mockBooked } : null);
    chain.then = (resolve, reject) => (table === 'products_catalog' && mockCatalogFails
      ? Promise.reject(new Error('catalog read failed'))
      : Promise.resolve(table === 'products_catalog' ? mockCatalogRows.filter((row) => !match || match(row))
        : (table === 'product_aliases' ? mockAliasRows : []))).then(resolve, reject);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const { OWNER_RULES, TECHNICIAN_NOTE_HEADER, CUSTOMER_WORDS_HEADER } = require('../services/service-report/report-writer-rules');

const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;
const CLEAN = 'WHAT WE DID\n\nWe treated the door thresholds and the foundation on the lanai side.\n\nWHAT WE FOUND\n\nGhost ants were trailing along the slider track, and activity was light.';
// The writer rules accept only the four-section report.
const CLEAN_V2 = "WHAT WE FOUND\n\nGhost ants were trailing along the slider track, and activity was light.\n\nWHAT WE DID AND WHY\n\nWe treated the door thresholds and the foundation on the lanai side.\n\nWHAT TO EXPECT\n\nThe technician will look at the slider track again next time.\n\nWHAT'S NEXT\n\nLet us know if the ants keep trailing along the slider track.";

function mkReq(body) {
  return {
    techRole: 'admin',
    body: {
      scheduledServiceId: '11111111-1111-4111-8111-111111111111',
      serviceType: mockServiceType,
      productsApplied: 'Taurus SC (0.5 fl oz/gal)',
      products: [{ productId: 'prod-1', name: 'Taurus SC', applicationMethod: 'perimeter_spray', areaValue: '120', areaUnit: 'linear_ft' }],
      ...body,
    },
  };
}
function mkRes() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
}

beforeEach(() => {
  mockProvider.mockReset();
  mockProvider.mockImplementation(async () => ({
    ok: true, text: process.env.GATE_REPORT_WRITER_RULES === 'true' ? CLEAN_V2 : CLEAN,
  }));
  mockBuildContext.mockClear();
  mockComms.mockReset();
  mockComms.mockImplementation(async () => ({ text: '', promptHint: '' }));
  mockCustomerWords.mockReset();
  mockCustomerWords.mockImplementation(async () => ({ text: '', promptHint: '' }));
  mockResolveMarks.mockReset();
  mockResolveMarks.mockImplementation(async () => []);
  mockProfile = { serviceKey: 'pest_general_quarterly', findingsType: null };
  mockServiceType = 'Quarterly Pest Control Service';
  mockCatalogRows = [];
  mockCatalogFails = false;
  mockAliasRows = [];
  mockBooked = {};
  delete process.env.GATE_REPORT_WRITER_RULES;
});
afterEach(() => { delete process.env.GATE_REPORT_WRITER_RULES; });

test.each([
  ['lawn_care_6week', null, 'Every 6 Weeks Lawn Care Service'],
  ['tree_shrub_program', 'tree_shrub', 'Bi-Monthly Tree & Shrub Care Service'],
  ['dethatching', null, 'Dethatching'],
])('gate on: %s reaches the model byte-identical (cache hit on the gate-off prompt)', async (serviceKey, findingsType, serviceType) => {
  mockProfile = { serviceKey, findingsType };
  mockServiceType = serviceType;
  const body = { serviceNotes: `Visit note for ${serviceKey}: fed the front beds and checked the back fence.` };
  const off = mkRes();
  await handler(mkReq(body), off);
  expect(off.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(mockBuildContext.mock.calls[0][0].writerRules).toBe(false);

  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const on = mkRes();
  await handler(mkReq(body), on);
  expect(on.statusCode).toBe(200);
  // Same system prompt + user message = same cache key: the provider is not
  // called again and the cached copy comes back.
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(on.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN, cached: true }));
  expect(mockBuildContext.mock.calls[1][0].writerRules).toBe(false);
});

test('gate on: pest gets the owner rules, the technician note block and no product names or rates', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Ghost ants on the slider track. Treated the thresholds and the lanai side of the foundation.' }), res);
  expect(res.statusCode).toBe(200);
  const call = mockProvider.mock.calls[0][0];
  expect(call.system).toContain(OWNER_RULES);
  expect(call.text).toContain(TECHNICIAN_NOTE_HEADER);
  expect(call.text).toContain('Products applied: 1 recorded. Names, amounts and rates are withheld on purpose');
  expect(call.text).not.toContain('Taurus');
  expect(call.text).not.toContain('fl oz');
  expect(call.text).not.toContain('Service Notes:');
  expect(mockBuildContext.mock.calls[0][0].writerRules).toBe(true);
});

test('gate on: a long technician note reaches the writer whole', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const res = mkRes();
  const note = `${'Checked the slider track and the lanai foundation. '.repeat(80)}Customer asked us to look at the garage door seal next time.`;
  await handler(mkReq({ serviceNotes: note }), res);
  expect(res.statusCode).toBe(200);
  expect(note.length).toBeGreaterThan(3000);
  expect(mockProvider.mock.calls[0][0].text).toContain('look at the garage door seal next time.');
});

test('gate off: pest keeps the exact legacy user message', async () => {
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Treated the thresholds.' }), res);
  const call = mockProvider.mock.calls[0][0];
  expect(call.system).not.toContain('OWNER RULES');
  expect(call.text).toContain('[COMPLETED WORK]\nService Notes: Treated the thresholds.');
  expect(call.text).toContain('Products Applied / Active Ingredients: Taurus SC (0.5 fl oz/gal)');
});

test('gate on: copy that breaks a rule is rejected and retried', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('We treated the door thresholds', 'We mixed 2 oz per gallon and treated the door thresholds') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Ants on the slider track; treated thresholds (retry case).' }), res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: a cached draft is never served for a different product set', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const body = { serviceNotes: 'Perimeter band on the lanai side (cache identity case).' };
  await handler(mkReq(body), mkRes());
  const second = mkRes();
  await handler(mkReq({
    ...body,
    productsApplied: 'Talak 7.9% F (0.33 fl oz/gal)',
    products: [{ productId: 'prod-2', name: 'Talak 7.9% F', applicationMethod: 'perimeter_spray' }],
  }), second);
  // Same prompt text (names are withheld), different products: the second
  // request is screened fresh instead of reusing the first draft.
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(mockProvider.mock.calls[0][0].text).toBe(mockProvider.mock.calls[1][0].text);
  expect(second.json.mock.calls[0][0]).not.toHaveProperty('cached');
});

// "Write again" on the Fast Complete sheet: the same inputs, a new draft.
test('fresh: a new draft for the same inputs replaces the cached one', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const body = { serviceNotes: 'Ghost ants on the slider track (write again case).' };
  await handler(mkReq(body), mkRes());
  expect(mockProvider).toHaveBeenCalledTimes(1);
  const SECOND = CLEAN_V2.replace('trailing along the slider track', 'trailing along the back slider track');
  mockProvider.mockImplementationOnce(async () => ({ ok: true, text: SECOND }));
  const again = mkRes();
  await handler(mkReq({ ...body, fresh: true }), again);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(again.json.mock.calls[0][0]).toEqual(expect.objectContaining({ report: SECOND }));
  expect(again.json.mock.calls[0][0]).not.toHaveProperty('cached');
  // A plain request for the same inputs now reads the newer draft back.
  const later = mkRes();
  await handler(mkReq(body), later);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(later.json).toHaveBeenCalledWith(expect.objectContaining({ report: SECOND, cached: true }));
});

test('gate on: the last-resort copy leaves out recorded items the rules forbid', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockProvider.mockImplementation(async () => ({ ok: false, reason: 'openai_503' }));
  const res = mkRes();
  await handler(mkReq({
    serviceNotes: 'Perimeter band (fallback case).',
    actionsCompleted: ['Exterior perimeter treatment', 'Web removal'],
    recommendations: ['Follow up in 7 days', 'Trim the shrubs off the wall'],
  }), res);
  expect(res.statusCode).toBe(200);
  const { report, deterministic } = res.json.mock.calls[0][0];
  expect(deterministic).toBe(true);
  expect(report).toContain('Exterior perimeter treatment');
  // Free-text recommendations never reach the rules-on fallback: aftercare
  // and next-visit timing belong to the report's own sections.
  expect(report).not.toContain('7 days');
  expect(report).not.toContain('Trim the shrubs');
  expect(report).not.toMatch(/linear ft/);
});

test('gate on: a zero activity rating leaves the last-resort copy standing', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockProvider.mockImplementation(async () => ({ ok: false, reason: 'openai_503' }));
  const res = mkRes();
  await handler(mkReq({
    serviceNotes: 'Perimeter band (zero rating case).',
    actionsCompleted: ['Exterior perimeter treatment'],
    pestActivityRating: 0,
  }), res);
  expect(res.statusCode).toBe(200);
  const { report, deterministic } = res.json.mock.calls[0][0];
  expect(deterministic).toBe(true);
  expect(report).toContain('Exterior perimeter treatment');
  expect(report).not.toMatch(/Recorded pest activity was/);
});

test('gate on: a failed catalog read fails retryable instead of screening weaker', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogFails = true;
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Perimeter band (catalog outage case).' }), res);
  expect(res.statusCode).toBe(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
  expect(mockProvider).not.toHaveBeenCalled();
});

test('gate on: a catalog product the note mentions is screened even though it was not applied', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'Termidor SC', active_ingredient: 'Fipronil' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'You asked about Termidor. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Customer asked about Termidor. Treated the thresholds (catalog mention case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: a catalog name the model brings on its own is screened though the prompt never mentions it', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'Termidor SC', active_ingredient: 'Fipronil' }, { name: 'Trapper T-Rex Rat Snap Trap', active_ingredient: null }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'We used Termidor here. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Treated the thresholds (unprompted catalog name case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: an ordinary word inside a catalog name does not reject the copy', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'Termidor SC', active_ingredient: 'Fipronil' }, { name: 'Trapper T-Rex Rat Snap Trap', active_ingredient: null }];
  const withTraps = CLEAN_V2.replace('Ghost ants were trailing', 'We checked the snap traps in the garage. Ghost ants were trailing');
  mockProvider.mockImplementationOnce(async () => ({ ok: true, text: withTraps }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Treated the thresholds and checked the garage (ordinary word case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: withTraps }));
});

test('gate on: a cached draft is screened again against the catalog as it is now', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const named = CLEAN_V2.replace('Ghost ants were trailing', 'We used Termidor here. Ghost ants were trailing');
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: named }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const body = { serviceNotes: 'Treated the thresholds (cached draft rescreen case).' };
  // The product is not in the catalog yet: the draft passes and is cached.
  const first = mkRes();
  await handler(mkReq(body), first);
  expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ report: named }));
  // Added to the catalog: the cached draft is not served.
  mockCatalogRows = [{ name: 'Termidor SC', active_ingredient: 'Fipronil' }];
  const second = mkRes();
  await handler(mkReq(body), second);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
  expect(second.json.mock.calls[0][0]).not.toHaveProperty('cached');
  // A clean cached draft is still served from the cache.
  const third = mkRes();
  await handler(mkReq(body), third);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(third.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2, cached: true }));
});

test('gate on: a cached draft is screened again for an active ingredient filled in since', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  const named = CLEAN_V2.replace('Ghost ants were trailing', 'We put down a quintazole band. Ghost ants were trailing');
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: named }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const body = {
    serviceNotes: 'Treated the thresholds (cached draft active case).',
    productsApplied: 'Zylo Mix (1 fl oz/gal)',
    products: [{ productId: 'prod-9', name: 'Zylo Mix', applicationMethod: 'perimeter_spray' }],
  };
  // The selected product has no active ingredient on file yet.
  mockCatalogRows = [{ id: 'prod-9', name: 'Zylo Mix', active_ingredient: null }];
  const first = mkRes();
  await handler(mkReq(body), first);
  expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ report: named }));
  // Filled in: the cached draft names it and is not served.
  mockCatalogRows = [{ id: 'prod-9', name: 'Zylo Mix', active_ingredient: 'Quintazole' }];
  const second = mkRes();
  await handler(mkReq(body), second);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
  expect(second.json.mock.calls[0][0]).not.toHaveProperty('cached');
});

test('gate on: a registered alias of a catalog product is screened', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ id: 'prod-3', name: 'Atticus Talak 7.9 F', active_ingredient: 'Bifenthrin' }];
  mockAliasRows = [{ product_id: 'prod-3', alias_name: 'Talstar P' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'We used Talstar here. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Treated the thresholds and the lanai (registered alias case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: an alias the note itself writes out is screened in any case', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ id: 'prod-4', name: 'Zylo Mix', active_ingredient: null }];
  mockAliasRows = [{ product_id: 'prod-4', alias_name: 'BugShield' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'You asked about bugshield. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Customer asked about bugshield. Treated the thresholds (mentioned alias case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: the active ingredients of a product the note names by alias are screened', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ id: 'prod-5', name: 'Hydretain Liquid', active_ingredient: 'Humectant blend' }];
  mockAliasRows = [{ product_id: 'prod-5', alias_name: 'Moisture Manager' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'We applied a humectant blend. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Applied moisture manager to dry spots. Treated the thresholds (alias actives case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: the active ingredients of a mentioned catalog product are screened too', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'In2Care Mosquito Station', active_ingredient: 'Beauveria bassiana; Pyriproxyfen' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'You asked about a Beauveria bassiana station. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Customer asked about In2Care stations. Treated the thresholds (mentioned actives case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: a catalog active the note names on its own is screened', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'AzaGuard', active_ingredient: 'Azadirachtin' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('Ghost ants were trailing', 'You asked about azadirachtin. Ghost ants were trailing') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Customer asked about azadirachtin. Treated the thresholds (direct active case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate on: a name-only product still has its catalog actives screened', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [{ name: 'Mosquito Dunks', active_ingredient: 'Beauveria bassiana' }];
  mockProvider
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2.replace('We treated the door thresholds', 'We placed Beauveria bassiana in the pond and treated the door thresholds') }))
    .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
  const res = mkRes();
  await handler(mkReq({
    serviceNotes: 'Dunks in the pond (name-only product case).',
    productsApplied: 'Mosquito Dunks (1 dunk)',
    products: [{ productId: null, name: 'Mosquito Dunks', applicationMethod: 'spot_treatment' }],
  }), res);
  expect(mockProvider).toHaveBeenCalledTimes(2);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
});

test('gate off: the same amount is not screened by the rules', async () => {
  const withAmount = CLEAN.replace('We treated the door thresholds', 'We mixed 2 oz per gallon and treated the door thresholds');
  mockProvider.mockImplementation(async () => ({ ok: true, text: withAmount }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Ants on the slider track; treated thresholds (gate-off case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: withAmount }));
});

test("gate on: customer messages arrive as the customer's own words with access codes scrubbed", async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCustomerWords.mockImplementation(async () => ({
    text: 'Customer text Sep 28: The ants are back by the dishwasher. Gate code 4821 if you need it.',
    promptHint: 'These are the customer\'s own recent messages.',
  }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Ants on the slider track (comms case).', includeCustomerComms: true }), res);
  expect(mockCustomerWords).toHaveBeenCalledTimes(1);
  expect(mockComms).not.toHaveBeenCalled();
  const { text } = mockProvider.mock.calls[0][0];
  expect(text).toContain(CUSTOMER_WORDS_HEADER);
  expect(text).toContain('The ants are back by the dishwasher.');
  expect(text).not.toContain('4821');
  expect(text).not.toContain('RECENT CUSTOMER COMMUNICATIONS');
});

test('gate off: customer messages keep the legacy block and options', async () => {
  mockComms.mockImplementation(async () => ({ text: 'Text Sep 28 (inbound): ants are back', promptHint: 'hint' }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Ants on the slider track (comms off case).', includeCustomerComms: true }), res);
  expect(mockComms).toHaveBeenCalledTimes(1);
  expect(mockCustomerWords).not.toHaveBeenCalled();
  expect(mockProvider.mock.calls[0][0].text).toContain('RECENT CUSTOMER COMMUNICATIONS\nhint\nText Sep 28 (inbound): ants are back');
});

describe('typed product application record', () => {
  const { buildTypedFindingsPromptBlock } = router._test;
  const values = {
    treatment_method: 'Trenching',
    areas_treated: 'Foundation perimeter',
    products_used: 'Termidor SC',
    gallons_or_amount: '40 gallons',
    linear_feet_or_stations: '180 linear ft',
  };

  test('is withheld from the prompt under the writer rules', () => {
    const block = buildTypedFindingsPromptBlock({ findingsType: 'termite_treatment', values, withholdProductRecord: true });
    expect(block).toContain('Trenching');
    expect(block).not.toContain('Product application record');
    expect(block).not.toContain('Termidor');
    expect(block).not.toContain('40 gallons');
    expect(block).not.toContain('180 linear ft');
  });

  test('stays in the prompt otherwise', () => {
    const block = buildTypedFindingsPromptBlock({ findingsType: 'termite_treatment', values });
    expect(block).toContain('Product application record');
    expect(block).toContain('Termidor SC');
  });
});

describe('booked reason', () => {
  beforeEach(() => {
    mockProfile = { serviceKey: 'pest_re_service', findingsType: null };
    mockServiceType = 'Pest Re-Service';
    mockBooked = {
      customer_request: 'Ants on the kitchen counter again. Gate code 4821.',
      customer_request_source: 'picker',
      customer_request_pests: ['ants'],
    };
  });

  test('gate on: the writer gets why the customer booked, attributed and scrubbed', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ghost ants at the slider (booked reason case).' }), res);
    expect(res.statusCode).toBe(200);
    const { text, system } = mockProvider.mock.calls[0][0];
    expect(text).toContain('BOOKED REASON (why the customer booked this visit, typed on the re-service page');
    expect(text).toContain('Reason: Ants on the kitchen counter again.');
    expect(text).not.toMatch(/Gate code|4821/);
    expect(system).toContain('CROSS-SERVICE MODIFIER — CALLBACK / RESERVICE');
  });

  test('gate off: the booked reason stays unread', async () => {
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ghost ants at the slider (booked reason off case).' }), res);
    const { text, system } = mockProvider.mock.calls[0][0];
    expect(text).not.toContain('BOOKED REASON');
    expect(text).not.toContain('Ants on the kitchen counter again');
    expect(system).not.toContain('CALLBACK / RESERVICE');
  });
});

describe('four-section report (writer rules v2)', () => {
  test('gate on: an answer in the old two-section shape is rejected and retried', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (shape retry case).' }), res);
    expect(mockProvider).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
  });

  test('gate off: the two-section shape is still the one accepted', async () => {
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (gate-off shape case).' }), res);
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN }));
  });

  test('gate on: the four-section report gets room to run longer', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (room case).' }), mkRes());
    expect(mockProvider.mock.calls[0][0].maxTokens).toBe(2000);
  });

  test('gate off: the paragraph keeps its budget', async () => {
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (budget case).' }), mkRes());
    expect(mockProvider.mock.calls[0][0].maxTokens).toBe(800);
  });

  test.each([
    ['a re-service', { serviceKey: 'pest_re_service', findingsType: null, billingType: 'one_time' }, {}, 're_service'],
    ['a callback', { serviceKey: 'pest_general_quarterly', findingsType: null, billingType: 'recurring' }, { is_callback: true }, 're_service'],
    ['a one-time service', { serviceKey: 'one_time_pest_control', findingsType: null, billingType: 'one_time' }, {}, 'one_time'],
    ['a one-time key on a recurring series', { serviceKey: 'one_time_pest_control', findingsType: null, billingType: 'one_time' }, { recurring_parent_id: 'parent-1' }, 'recurring'],
    ["a one-time service carrying the 'one_time' pattern marker", { serviceKey: 'one_time_pest_control', findingsType: null, billingType: 'one_time' }, { recurring_pattern: 'one_time' }, 'one_time'],
    ['a recurring plan visit', { serviceKey: 'pest_general_quarterly', findingsType: null, billingType: 'recurring' }, {}, 'recurring'],
    ['an unresolved profile', { serviceKey: null, findingsType: null, billingType: null, synthesized: true }, {}, null],
    ['an unresolved profile on a recurring series', { serviceKey: null, findingsType: null, billingType: null }, { recurring_parent_id: 'parent-1' }, 'recurring'],
  ])('gate on: %s reaches the context builder with its service type', async (label, profile, row, kind) => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProfile = profile;
    mockBooked = row;
    await handler(mkReq({ serviceNotes: `Ants on the slider track (${label} case).` }), mkRes());
    // (An unresolved profile has no in-scope writer; only its kind is judged here.)
    expect(mockBuildContext.mock.calls[0][0]).toEqual(expect.objectContaining({ serviceKind: kind }));
  });

  test('gate on: a timeframe from the approved wording passes; an invented one is retried', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockBuildContext.mockImplementationOnce(async () => ({ contextText: '', signals: {}, writerAllowedPhrases: ['a few days'] }));
    const supplied = CLEAN_V2.replace('The technician will look at the slider track again next time.', 'You may see a few more ants for a few days.');
    const invented = CLEAN_V2.replace('The technician will look at the slider track again next time.', 'Activity should drop within 3 weeks.');
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: invented }))
      .mockImplementationOnce(async () => ({ ok: true, text: supplied }));
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (timeframe case).' }), res);
    expect(mockProvider).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: supplied }));
  });

  test('gate on: the typed activity score reads as a gauge, not a severity', () => {
    const { buildTypedFindingsPromptBlock } = router._test;
    const values = { termite_activity: 'Active termites present', bait_consumption: 'Light termite feeding on the bait' };
    const gauge = buildTypedFindingsPromptBlock({ findingsType: 'termite_bait_station', values, activityScore: 4, activityGauge: true });
    expect(gauge).toContain('gauge on the report, set by the form from the recorded answers (never restate it, and never call it high or low): 4/5');
    expect(gauge).not.toContain('4/5 (high)');
    const legacy = buildTypedFindingsPromptBlock({ findingsType: 'termite_bait_station', values, activityScore: 4 });
    expect(legacy).toContain('4/5 (high)');
  });
});

describe('the promise check reaches the writer', () => {
  const MARKS = [{ id: '00000000-0000-4000-8000-000000000001', mark: 'done' }];
  const RESOLVED = [{ id: MARKS[0].id, mark: 'done', description: 'Check under the dishwasher', source: 'call' }];

  test("gate on: the technician's marks are resolved for the visit's customer and handed to the records", async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockResolveMarks.mockImplementation(async () => RESOLVED);
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (promise case).', promiseMarks: MARKS }), mkRes());
    expect(mockResolveMarks).toHaveBeenCalledWith(expect.anything(), { customerId: 'customer-1', marks: MARKS });
    expect(mockBuildContext.mock.calls[0][0]).toEqual(expect.objectContaining({ visitPromises: RESOLVED }));
  });

  test('gate off: marks are never read', async () => {
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (promise off case).', promiseMarks: MARKS }), mkRes());
    expect(mockResolveMarks).not.toHaveBeenCalled();
    expect(mockBuildContext.mock.calls[0][0]).toEqual(expect.objectContaining({ visitPromises: [] }));
  });

  test('gate on, lawn: outside the writer, marks are never read', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProfile = { serviceKey: 'lawn_care_6week', findingsType: null };
    mockServiceType = 'Every 6 Weeks Lawn Care Service';
    await handler(mkReq({ serviceNotes: 'Fed the front lawn (promise lawn case).', promiseMarks: MARKS }), mkRes());
    expect(mockResolveMarks).not.toHaveBeenCalled();
  });

  test('gate on: a marked promise is visit detail on its own; without it a bare request is refused', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    const bare = { serviceNotes: '', productsApplied: '', products: [] };
    const refused = mkRes();
    await handler(mkReq(bare), refused);
    expect(refused.statusCode).toBe(400);
    mockResolveMarks.mockImplementation(async () => RESOLVED);
    // The context carried the PROMISES record.
    mockBuildContext.mockImplementationOnce(async () => ({ contextText: 'PROMISES', signals: { hasVisitPromises: true } }));
    const generated = mkRes();
    await handler(mkReq({ ...bare, promiseMarks: MARKS }), generated);
    expect(generated.statusCode).toBe(200);
    expect(mockBuildContext.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ visitPromises: RESOLVED }));
  });

  test('gate on: marks alone whose grounding is lost are refused retryably, never written from nothing', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockResolveMarks.mockImplementation(async () => RESOLVED);
    mockBuildContext.mockImplementationOnce(async () => { throw new Error('context down'); });
    const res = mkRes();
    await handler(mkReq({ serviceNotes: '', productsApplied: '', products: [], promiseMarks: MARKS }), res);
    expect(res.statusCode).toBe(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'promise_grounding_unavailable', retryable: true }));
    expect(mockProvider).not.toHaveBeenCalled();
  });

  test('gate on: a failed promise read writes the report without them', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockResolveMarks.mockImplementation(async () => { throw new Error('ledger down'); });
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (promise failure case).', promiseMarks: MARKS }), res);
    expect(res.statusCode).toBe(200);
    expect(mockBuildContext.mock.calls[0][0]).toEqual(expect.objectContaining({ visitPromises: [] }));
  });
});


// Prod 2026-10-02: a visit's notes said "yard" and "along with", which made
// yard-sign supplies and two fertilizers whose names hold "with" count as
// products the prompt named; every draft was refused for "with" or "Waves",
// and the office read "temporarily unavailable".
test('gate on: notes that say "yard" and "along with" keep an ordinary draft; supplies and "with" are no brands (prod 2026-10-02)', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [
    { name: 'Pesticide application sign 4x5 (yard sign card)', category: 'supplies', active_ingredient: null },
    { name: 'Yard sign sticker 4x5 "Serviced by Waves"', category: 'supplies', active_ingredient: null },
    { name: 'LESCO 24-0-11 with PolyPlus OPTI', category: 'fertilizer', active_ingredient: '24-0-11' },
    { name: 'The Andersons 17-0-3 Fertilizer with Grubout Plus', category: 'fertilizer', active_ingredient: 'Unknown - pending SDS' },
  ];
  const ordinary = CLEAN_V2
    .replace('We treated the door thresholds', 'Along with the yard, we treated the door thresholds')
    .replace('Let us know', 'Let Waves know');
  mockProvider.mockImplementation(async () => ({ ok: true, text: ordinary }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'A repellent solution along with a surfactant went into the yard and ornamentals (ordinary words case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: ordinary }));
});

test('gate on: every draft refused for its wording, with nothing safe to fall back on, says so instead of "unavailable" (prod 2026-10-02)', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockProvider.mockImplementation(async () => ({ ok: true, text: CLEAN_V2.replace('activity was light.', 'activity was light, and the treatment is safe for pets.') }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Treated the thresholds (refused wording case).', products: [], productsApplied: '' }), res);
  expect(res.statusCode).toBe(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    retryable: true,
    error: expect.stringMatching(/did not pass the report’s wording checks/),
  }));
});

// Audit 2026-10-03 (prod, read-only): plain words inside catalog names
// ("high", "contact", "monitoring", "moisture") marked those products
// mentioned and their full screens refused about half of real pest reports.
test('gate on: a note of plain words that sit inside catalog names keeps an ordinary draft on the first attempt (audit 2026-10-03)', async () => {
  process.env.GATE_REPORT_WRITER_RULES = 'true';
  mockCatalogRows = [
    { id: 'c1', name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', category: 'fertilizer', active_ingredient: null },
    { id: 'c2', name: 'LESCO Manicure 6FL Contact Fungicide', category: 'fungicide', active_ingredient: null },
    { id: 'c3', name: 'HexPro Termite Monitoring Baiting System', category: 'termite monitoring', active_ingredient: null },
    { id: 'c4', name: 'LESCO Moisture Manager', category: 'soil moisture management aid', active_ingredient: null },
  ];
  const ordinary = CLEAN_V2
    .replace('Ghost ants were trailing', 'Activity was high, and ghost ants were trailing')
    .replace("Let us know if the ants keep trailing along the slider track.", 'Contact us if the ants keep trailing; we will keep monitoring the moisture by the track.');
  mockProvider.mockImplementation(async () => ({ ok: true, text: ordinary }));
  const res = mkRes();
  await handler(mkReq({ serviceNotes: 'Activity was high by the slider. Moisture at the track, keep monitoring. The customer may contact us (plain words case).' }), res);
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: ordinary }));
});

// Owner 2026-10-09: a note with "no issues inside" cost four blind drafts and
// then the standard report. A rejected draft now goes back with what it broke.
describe('a rejected draft is repaired, not written blind again', () => {
  const REJECTED = CLEAN_V2.replace('and activity was light.', 'and there were no issues inside.');

  test('gate on: the same provider gets its draft back with the reason and the words that tripped it', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: REJECTED }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (repair case).' }), res);
    expect(mockProvider).toHaveBeenCalledTimes(2);
    const [first, second] = mockProvider.mock.calls.map(([call]) => call);
    expect(first.text).not.toContain('PREVIOUS DRAFT');
    expect(second.text.startsWith(first.text)).toBe(true);
    expect(second.system).toBe(first.system);
    const note = second.text.slice(first.text.length);
    expect(note).toContain(`PREVIOUS DRAFT (rejected; never reuse its wording where it broke the rule):\n${REJECTED}`);
    expect(note).toContain('A PREVIOUS DRAFT OF THIS REPORT WAS REJECTED because it uses a phrase the report refuses');
    expect(note).toContain('The words that tripped it: "no issues".');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
  });

  test('gate on: the backup provider gets the reason and the words, never the other provider\'s draft', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: REJECTED }))
      .mockImplementationOnce(async () => ({ ok: true, text: REJECTED }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (backup repair case).' }), mkRes());
    expect(mockProvider).toHaveBeenCalledTimes(3);
    const [first, , third] = mockProvider.mock.calls.map(([call]) => call);
    const note = third.text.slice(first.text.length);
    expect(note).not.toContain('PREVIOUS DRAFT (rejected');
    expect(note).not.toContain('Ghost ants were trailing');
    expect(note).toContain('The words that tripped it: "no issues".');
  });

  test('gate on: a shaped draft the parser refuses for a word is repaired by that word, not as a bad shape', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    const shaped = CLEAN_V2.replace('and activity was light.', 'and it looked like an infestation.');
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: shaped }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
    const res = mkRes();
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (parser word repair case).' }), res);
    expect(mockProvider).toHaveBeenCalledTimes(2);
    const [first, second] = mockProvider.mock.calls.map(([call]) => call);
    const note = second.text.slice(first.text.length);
    expect(note).toMatch(/REJECTED because it uses words the report refuses \("infestation"/);
    expect(note).not.toContain('it is not the four titles');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ report: CLEAN_V2 }));
  });

  test('gate on: a draft in the wrong shape is still repaired as a bad shape', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN_V2 }));
    await handler(mkReq({ serviceNotes: 'Ants on the slider track (shape repair case).' }), mkRes());
    const [first, second] = mockProvider.mock.calls.map(([call]) => call);
    expect(second.text.slice(first.text.length)).toContain('it is not the four titles');
  });

  test('gate on: a note that says "no issues" carries the hint under the note', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    await handler(mkReq({ serviceNotes: 'Sprayed the perimeter, customer home, No Issues inside (hint case).' }), mkRes());
    expect(mockProvider.mock.calls[0][0].text).toContain('(The note says "no issues". The report refuses those words:');
    mockProvider.mockClear();
    await handler(mkReq({ serviceNotes: 'Sprayed the perimeter, customer home (no hint case).' }), mkRes());
    expect(mockProvider.mock.calls[0][0].text).not.toContain('The report refuses those words');
  });

  test('gate off: the retry is the same message, and no hint is added', async () => {
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: 'not a report' }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN }));
    await handler(mkReq({ serviceNotes: 'Ants on the slider track, no issues inside (gate-off repair case).' }), mkRes());
    expect(mockProvider).toHaveBeenCalledTimes(2);
    const [first, second] = mockProvider.mock.calls.map(([call]) => call);
    expect(second.text).toBe(first.text);
    expect(first.text).not.toContain('The report refuses those words');
  });

  test('gate on, lawn: outside the writer rules the retry stays the same message', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockProfile = { serviceKey: 'lawn_care_6week', findingsType: null };
    mockServiceType = 'Every 6 Weeks Lawn Care Service';
    mockProvider
      .mockImplementationOnce(async () => ({ ok: true, text: 'not a report' }))
      .mockImplementationOnce(async () => ({ ok: true, text: CLEAN }));
    await handler(mkReq({ serviceNotes: 'Fed the front lawn, no issues (lawn repair case).' }), mkRes());
    const calls = mockProvider.mock.calls.map(([call]) => call);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1].text).toBe(calls[0].text);
    expect(calls[0].text).not.toContain('The report refuses those words');
  });
});
