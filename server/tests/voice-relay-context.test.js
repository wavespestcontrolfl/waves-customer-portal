/**
 * Voice-relay Phase 2 "context" — caller recognition + read-only account/pricing
 * tools, dark behind VOICE_RELAY_CONTEXT_ENABLED (fail-closed).
 *
 * Matrix (per the owner's ruling):
 *   - gate off  → no context tools registered, prompt byte-identical, no DB touch
 *   - unknown   → no KNOWN CALLER block, account tools refuse
 *   - ambiguous → 2+ customers share the number ⇒ treated exactly as unknown
 *   - matched   → block present, tools return data
 *   - get_pricing → engine values ONLY (generateEstimate — the estimator's read
 *     path), says what's missing rather than guessing
 *   - no context tool ever performs a write
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
// The canonical identity column set + prior-call summary come FROM the call
// pipeline (named production exports) — mirror its real column set here.
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../services/waveguard-existing-services', () => ({ loadOwnedRecurringServiceKeys: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((notes) => (notes ? `SAFE:${notes}` : null)) }));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../utils/service-normalizer', () => ({ normalizeServiceType: jest.fn((v) => v) }));
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));

const db = require('../models/db');
const { summarizePriorCall } = require('../services/call-recording-processor');
const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
const { openBalanceSummary } = require('../services/open-balance');
const { generateEstimate } = require('../services/pricing-engine');

const relayContext = require('../services/voice-agent/relay-context');
const { TOOLS, CONTEXT_TOOLS, activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { SYSTEM_PROMPT, buildBasePrompt, PRICE_LINE_NO_CONTEXT } = require('../services/voice-agent/relay-conversation');

// Synthetic fixtures only — 555 numbers, no real customer data (repo P0).
const FROM = '+19415550142';
const CUSTOMER = { id: 'c-1111', first_name: 'Pat', member_since: '2023-04-01T00:00:00Z', pipeline_stage: 'active_customer' };

// Chainable knex-builder stub: every chain method returns the builder, the
// builder is thenable (resolves `rows`), `.first()` resolves rows[0]. Write
// verbs exist only as spies so "no writes" is provable.
function makeBuilder(rows) {
  const b = {};
  const chain = ['whereNull', 'whereIn', 'orderBy', 'select', 'limit', 'offset', 'whereRaw', 'orWhereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereNot'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.update = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
function primeDb({ customers = [], scheduled = [], records = [] } = {}) {
  builders = {
    customers: makeBuilder(customers),
    scheduled_services: makeBuilder(scheduled),
    service_records: makeBuilder(records),
  };
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });
}

function assertNoWrites() {
  for (const b of Object.values(builders || {})) {
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
    expect(b.del).not.toHaveBeenCalled();
  }
}

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  primeDb();
  loadOwnedRecurringServiceKeys.mockResolvedValue([]);
  openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
  summarizePriorCall.mockResolvedValue(null);
});

describe('GATE OFF (default) — everything dark, fail-closed', () => {
  test('no context tools registered', () => {
    expect(relayContext.isContextEnabled()).toBe(false);
    expect(activeTools()).toEqual(TOOLS);
    expect(activeTools().map((t) => t.name)).not.toEqual(expect.arrayContaining(['get_account_overview']));
  });

  test('base prompt is byte-identical to Phase 1 (incl. the CANNOT-quote-prices line)', () => {
    expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain(PRICE_LINE_NO_CONTEXT); // pins the replace target
    expect(SYSTEM_PROMPT).not.toContain('KNOWN CALLER');
    expect(SYSTEM_PROMPT).not.toContain('get_pricing');
  });

  test('resolveCallerContext returns null WITHOUT touching the DB', async () => {
    expect(await relayContext.resolveCallerContext(FROM)).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('context tools refuse even with a customerId in ctx (defense in depth), no DB touch', async () => {
    for (const name of ['get_account_overview', 'get_service_history', 'get_pricing', 'lookup_customer']) {
      const out = await executeTool(name, { service: 'pest_control', home_sqft: 2000 }, { customerId: 'c-1111' });
      expect(out).toMatch(/not available/i);
    }
    expect(db).not.toHaveBeenCalled();
    expect(generateEstimate).not.toHaveBeenCalled();
  });
});

describe('GATE ON — caller recognition', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('context tools register alongside the Phase 0/1 tools', () => {
    const names = activeTools().map((t) => t.name).sort();
    expect(names).toEqual(['capture_lead', 'find_slots', 'get_account_overview', 'get_availability',
      'get_call_history', 'get_message_history', 'get_pricing', 'get_service_history', 'lookup_customer']);
    expect(CONTEXT_TOOLS.every((t) => t.input_schema)).toBe(true);
  });

  test('gate-on prompt swaps the price line for the get_pricing rule + persona + trust boundary', () => {
    const p = buildBasePrompt(true);
    expect(p).not.toContain('You CANNOT quote prices');
    expect(p).toContain('get_pricing tool');
    expect(p).toContain('Never negotiate');
    expect(p).toContain('your name is Sandy');
    expect(p).toContain('never claim to be human');
    expect(p).toContain('ACCOUNT ACCESS RULES');
    expect(p).toContain("Verify, don't recite");
    // Phase B: lookup + confirm-don't-recite for non-matching voices, and
    // pricing declared public.
    expect(p).toContain('lookup_customer');
    expect(p).toContain("confirm-don't-recite");
    expect(p).toContain('Pricing is public website information');
    // Everything BEFORE the price line is untouched.
    expect(p).toContain('ONLY state appointment times that a tool actually returned');
  });

  test('VOICE_AGENT_NAME overrides the persona name', () => {
    process.env.VOICE_AGENT_NAME = 'Marge';
    try {
      expect(buildBasePrompt(true)).toContain('your name is Marge');
    } finally {
      delete process.env.VOICE_AGENT_NAME;
    }
  });

  test('unknown caller → null (no block), matcher queried all 4 canonical columns', async () => {
    primeDb({ customers: [] });
    expect(await relayContext.resolveCallerContext(FROM)).toBeNull();
    const custQ = builders.customers;
    expect(custQ.whereNull).toHaveBeenCalledWith('deleted_at');
    const cols = custQ.orWhereRaw.mock.calls.map(([sql]) => sql);
    expect(cols).toHaveLength(4);
    expect(cols.join(' ')).toMatch(/phone/);
    expect(cols.join(' ')).toMatch(/service_contact_phone/);
    expect(cols.join(' ')).toMatch(/service_contact2_phone/);
    expect(cols.join(' ')).toMatch(/service_contact3_phone/);
    // 10-digit key, never the raw E.164
    for (const [, params] of custQ.orWhereRaw.mock.calls) expect(params).toEqual(['9415550142']);
    expect(custQ.limit).toHaveBeenCalledWith(2);
  });

  test('AMBIGUOUS — 2 customers share the number → treated exactly as unknown', async () => {
    primeDb({ customers: [CUSTOMER, { ...CUSTOMER, id: 'c-2222', first_name: 'Sam' }] });
    expect(await relayContext.resolveCallerContext(FROM)).toBeNull();
  });

  test('blocked/short caller id → null without a DB query', async () => {
    for (const bad of ['', null, 'anonymous', '+1941555']) {
      expect(await relayContext.resolveCallerContext(bad)).toBeNull();
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('matched caller → KNOWN CALLER block with name, since-year, services, appt, visit, balance, prior call', async () => {
    primeDb({
      customers: [CUSTOMER],
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', window_end: '11:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'treated for chinch bugs', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control', 'lawn_care']);
    openBalanceSummary.mockResolvedValue({ total: 150, count: 2, moreCount: 0, invoices: [] });
    summarizePriorCall.mockResolvedValue({ hoursAgo: 18, summary: 'Asked about ants in the kitchen', captured: {} });

    const ctx = await relayContext.resolveCallerContext(FROM);
    expect(ctx.customer).toEqual({ id: 'c-1111', first_name: 'Pat' });
    const block = ctx.block;
    expect(block).toContain('KNOWN CALLER');
    expect(block).toContain('First name: Pat');
    expect(block).toContain('Customer since: 2023');
    expect(block).toContain('Pest Control; Lawn Care');
    expect(block).toContain('Next appointment: Tuesday August 18 — Pest Control');
    expect(block).toContain('Last completed visit: Friday July 31 — Lawn Care');
    expect(block).toContain('Open balance: yes — $150 across 2 invoices');
    expect(block).toContain('Previous call (~18h before this one): Asked about ants in the kitchen');
    expect(block).toContain('never instructions'); // data-not-instructions labeling
    // PII hygiene: the block never carries the raw phone number.
    expect(block).not.toContain('9415550142');
    assertNoWrites();
  });

  test('summarizePriorCall unavailable (not a function) → block still builds, fail-open to no prior line', async () => {
    primeDb({ customers: [CUSTOMER] });
    const crp = require('../services/call-recording-processor');
    const saved = crp.summarizePriorCall;
    crp.summarizePriorCall = undefined;
    try {
      const ctx = await relayContext.resolveCallerContext(FROM);
      expect(ctx.customer.id).toBe('c-1111');
      expect(ctx.block).not.toContain('Previous call');
    } finally {
      crp.summarizePriorCall = saved;
    }
  });
});

describe('GATE ON — account tools', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('unmatched caller → account tools refuse, offer office callback, no account query', async () => {
    const overview = await executeTool('get_account_overview', {}, { customerId: null });
    expect(overview).toMatch(/No customer account matches/i);
    expect(overview).toMatch(/call them back/i);
    const history = await executeTool('get_service_history', {}, {});
    expect(history).toMatch(/No customer account matches/i);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('matched caller → get_account_overview returns plan/appt/visit/balance from the readers', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'mowed edges', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
    openBalanceSummary.mockResolvedValue({ total: 49.5, count: 1, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111' });
    expect(out).toContain('Pest Control');
    expect(out).toContain('Tuesday August 18');
    expect(out).toContain('Friday July 31');
    expect(out).toContain('$49.50');
    assertNoWrites();
  });

  test('get_service_history → last visits use the customer-facing notes scrub, never raw internal notes', async () => {
    primeDb({
      records: [
        { service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' },
        { service_date: '2026-06-15', service_type: 'Pest Control', technician_notes: 'internal-only-secret', structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }), status: 'completed' },
      ],
    });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111' });
    // customerSafeServiceNotes (mocked as SAFE:-prefix) is the ONLY notes path.
    expect(out).toContain('SAFE:note-1');
    // internal_only typed delivery suppresses notes entirely (same predicate
    // as the customer portal's GET /api/services).
    expect(out).not.toContain('internal-only-secret');
    expect(out).not.toContain('SAFE:internal-only-secret');
    assertNoWrites();
  });

  test('balance of zero reads as none', async () => {
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111' });
    expect(out).toMatch(/Open balance: none/);
  });
});

describe('GATE ON — lookup_customer (output shaping is the point)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  // Rows deliberately carry every sensitive field a naive SELECT * would leak;
  // the assertions below prove none of it ever reaches the model.
  const ROW = {
    id: 'c-9001',
    first_name: 'Dana',
    last_name: 'Whitfield',
    city: 'Sarasota',
    address_line1: '482 Palmetto Grove Ln',
    email: 'dana@example.com',
    phone: '+19415550999',
  };

  function lookupCtx() {
    const refs = new Map();
    return {
      customerId: null,
      rememberLookup: (row) => {
        const ref = `C${refs.size + 1}`;
        refs.set(ref, row.id);
        return ref;
      },
      resolveLookupRef: (ref) => refs.get(String(ref || '').trim().toUpperCase()) || null,
      _refs: refs,
    };
  }

  test('single match → match-found + first name + city + ref, NEVER address/email/phone/id', async () => {
    primeDb({ customers: [ROW] });
    const ctx = lookupCtx();
    const out = await executeTool('lookup_customer', { name: 'Dana Whitfield' }, ctx);
    expect(out).toContain('Dana');
    expect(out).toContain('Sarasota');
    expect(out).toMatch(/customer_ref: C1/);
    // Output shaping — no record dump, ever:
    expect(out).not.toContain('482');
    expect(out).not.toContain('Palmetto Grove');
    expect(out).not.toContain('dana@example.com');
    expect(out).not.toContain('5550999');
    expect(out).not.toContain('c-9001'); // raw id never crosses the model boundary
    expect(out).toMatch(/confirm details they state/i);
    assertNoWrites();
  });

  test('name tokens must each hit first OR last name; street searches address_line1; phone uses the canonical digit key', async () => {
    primeDb({ customers: [ROW] });
    const ctx = lookupCtx();
    await executeTool('lookup_customer', { name: 'Dana Whitfield', street: 'Palmetto Grove', phone: '941-555-0999' }, ctx);
    const b = builders.customers;
    expect(b.whereNull).toHaveBeenCalledWith('deleted_at');
    const rawSqls = [...b.whereRaw.mock.calls, ...b.orWhereRaw.mock.calls].map(([sql]) => sql);
    expect(rawSqls.join(' ')).toMatch(/first_name ILIKE/);
    expect(rawSqls.join(' ')).toMatch(/last_name ILIKE/);
    expect(rawSqls.join(' ')).toMatch(/address_line1 ILIKE/);
    // Phone matching reuses the same 10-digit key predicate as the ANI matcher.
    const phoneParams = b.orWhereRaw.mock.calls.map(([, params]) => params).flat();
    expect(phoneParams).toContain('9415550999');
    // The looked-up row's SELECT never pulls address/email/phone columns.
    expect(b.select).toHaveBeenCalledWith('id', 'first_name', 'city');
  });

  test('no usable criteria → asks for name/street/phone, no DB query', async () => {
    const out = await executeTool('lookup_customer', { name: 'D' }, lookupCtx());
    expect(out).toMatch(/name.*street address.*phone/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('AMBIGUOUS (2–5 matches) → count + first names only, asks the caller to narrow', async () => {
    primeDb({
      customers: [
        { ...ROW, id: 'c-1', first_name: 'Dana' },
        { ...ROW, id: 'c-2', first_name: 'Daniel', city: 'Venice', address_line1: '9 Oak St', email: 'dw@example.com' },
      ],
    });
    const ctx = lookupCtx();
    const out = await executeTool('lookup_customer', { name: 'Whitfield' }, ctx);
    expect(out).toContain('2 accounts');
    expect(out).toContain('Dana');
    expect(out).toContain('Daniel');
    expect(out).toMatch(/narrow/i);
    // Ambiguous results carry NO refs, cities, or any other fields.
    expect(out).not.toMatch(/customer_ref/);
    expect(out).not.toContain('Sarasota');
    expect(out).not.toContain('Venice');
    expect(out).not.toContain('Oak St');
    expect(ctx._refs.size).toBe(0);
  });

  test('6+ matches → too many, no names at all', async () => {
    primeDb({ customers: Array.from({ length: 6 }, (_, i) => ({ ...ROW, id: `c-${i}`, first_name: `Name${i}` })) });
    const out = await executeTool('lookup_customer', { name: 'Smith' }, lookupCtx());
    expect(out).toMatch(/more than five/i);
    expect(out).not.toContain('Name0');
    expect(out).not.toMatch(/customer_ref/);
  });

  test('no match → suggests re-checking, captures as lead', async () => {
    primeDb({ customers: [] });
    const out = await executeTool('lookup_customer', { name: 'Zebulon Quark' }, lookupCtx());
    expect(out).toMatch(/No account matches/i);
  });
});

describe('GATE ON — disclosure tiers (enforced in tool output, not prompt language)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  function refCtx({ ani = null } = {}) {
    return {
      customerId: ani,
      resolveLookupRef: (ref) => (String(ref).toUpperCase() === 'C1' ? 'c-9001' : null),
    };
  }

  test('looked-up (non-ANI) overview is REDACTED: dates + services + balance yes/no; no amounts, no window', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'gate code 4482', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
    openBalanceSummary.mockResolvedValue({ total: 231.75, count: 3, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', { customer_ref: 'C1' }, refCtx({ ani: 'c-someone-else' }));
    // Dates + service names survive:
    expect(out).toContain('Pest Control');
    expect(out).toContain('Tuesday August 18');
    expect(out).toContain('Friday July 31');
    // Balance is yes/no only — never the amount:
    expect(out).toMatch(/Open balance: yes/);
    expect(out).not.toContain('$231.75');
    expect(out).not.toMatch(/\$\d/);
    // No appointment window on the redacted tier:
    expect(out).not.toContain('9:00 AM');
    expect(out).toMatch(/confirm details the caller states/i);
    assertNoWrites();
  });

  test('looked-up ref that IS the ANI-matched caller → full tier (their own account)', async () => {
    openBalanceSummary.mockResolvedValue({ total: 49.5, count: 1, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', { customer_ref: 'C1' }, refCtx({ ani: 'c-9001' }));
    expect(out).toContain('$49.50');
  });

  test('redacted history: dates + service names only — visit summaries stripped', async () => {
    primeDb({
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'gate code 4482', structured_notes: null, status: 'completed' }],
    });
    const out = await executeTool('get_service_history', { customer_ref: 'C1' }, refCtx({ ani: null }));
    expect(out).toContain('Friday July 31 — Lawn Care');
    expect(out).not.toContain('SAFE:'); // the (already-scrubbed) summary itself is withheld on this tier
    expect(out).not.toContain('4482');
  });

  test('invented/unknown customer_ref → refused, no account read', async () => {
    const out = await executeTool('get_account_overview', { customer_ref: 'C7' }, refCtx({ ani: 'c-9001' }));
    expect(out).toMatch(/not from a lookup_customer result/i);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('full tier for the matched caller is unchanged by the tier plumbing', async () => {
    primeDb({
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' }],
    });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111' });
    expect(out).toContain('SAFE:note-1');
  });
});

describe('GATE ON — get_pricing (estimator read path only)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('UNMATCHED caller → get_pricing works (pricing is public website information)', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{
        service: 'pest_control', perApp: 112, monthly: 37.33, annual: 448,
        monthlyAfterDiscount: 37.33, annualAfterDiscount: 448,
        frequency: 'quarterly', visitsPerYear: 4, initialFee: 99, requiresManualReview: false,
      }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000 }, { customerId: null });
    expect(generateEstimate).toHaveBeenCalled();
    expect(out).toContain('$112 per application');
    expect(out).toMatch(/Quote ONLY these numbers/);
  });

  test('missing required inputs → says exactly what is missing, engine untouched, no guessed number', async () => {
    const out = await executeTool('get_pricing', { service: 'pest_control' }, { customerId: 'c-1111' });
    expect(out).toContain('home_sqft');
    expect(out).toMatch(/Do NOT guess/i);
    expect(out).not.toMatch(/\$\d/);
    expect(generateEstimate).not.toHaveBeenCalled();

    const lawn = await executeTool('get_pricing', { service: 'lawn_care', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(lawn).toContain('lot_sqft');
    expect(generateEstimate).not.toHaveBeenCalled();
  });

  test('pest pricing comes ONLY from generateEstimate (the /calculate read path), per-APPLICATION wording', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{
        service: 'pest_control', perApp: 112, monthly: 37.33, annual: 448,
        monthlyAfterDiscount: 37.33, annualAfterDiscount: 448,
        frequency: 'quarterly', visitsPerYear: 4, initialFee: 99, requiresManualReview: false,
      }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000, frequency: 'quarterly' }, { customerId: 'c-1111' });
    expect(generateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      homeSqFt: 2000,
      propertyType: 'single_family',
      services: { pest: { frequency: 'quarterly' } },
    }));
    expect(out).toContain('$112 per application');
    expect(out).toContain('$37.33');
    expect(out).toContain('$448');
    expect(out).toContain('$99 setup fee');
    expect(out).toMatch(/Quote ONLY these numbers/);
    // Owner rule: "per application", never "per visit".
    expect(out).not.toMatch(/per visit/i);
    // Every dollar figure in the reply came from the engine line.
    const dollars = out.match(/\$[\d.]+/g) || [];
    expect(new Set(dollars)).toEqual(new Set(['$112', '$37.33', '$448', '$99']));
  });

  test('termite_bait forces the trelona/basic program like public-quote and reports install + monitoring', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{ service: 'termite_bait', perApp: 72, monthly: 35, annual: 420, monthlyAfterDiscount: 35, annualAfterDiscount: 420, visitsPerYear: 4, install: { price: 610 }, requiresManualReview: false }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'termite_bait', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(generateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      services: { termite: { system: 'trelona', monitoringTier: 'basic' } },
    }));
    expect(out).toContain('$610 station installation');
    expect(out).toContain('$35 per month monitoring');
  });

  test('manual-review line → refuses to state a price', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{ service: 'tree_shrub', perApp: 90, requiresManualReview: true }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'tree_shrub', home_sqft: 2000, lot_sqft: 30000 }, { customerId: 'c-1111' });
    expect(out).toMatch(/custom quote/i);
    expect(out).toMatch(/do not state a price/i);
    expect(out).not.toContain('$90');
  });

  test('engine throwing → generic fail-closed reply, never a number', async () => {
    generateEstimate.mockImplementation(() => { throw new Error('constants not synced'); });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(out).toMatch(/Could not look that up/i);
    expect(out).not.toMatch(/\$\d/);
  });
});

describe('RelayConversation wiring', () => {
  test('gate off → no context resolution is even started', () => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    expect(convo._contextReady).toBeNull();
    expect(convo._callerContext).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on + matched → _callerContext carries the customer id for toolCtx', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    primeDb({ customers: [CUSTOMER] });
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    await convo._contextReady;
    expect(convo._callerContext.customer.id).toBe('c-1111');
    expect(convo._callerContext.block).toContain('KNOWN CALLER');
  });

  test('gate on + unknown → _callerContext stays null (agent behaves exactly as today)', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    primeDb({ customers: [] });
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    await convo._contextReady;
    expect(convo._callerContext).toBeNull();
  });
});
