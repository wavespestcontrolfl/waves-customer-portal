// Codex #4933 r3 P2: "Reconstruct the live known-caller lookup in audits".
//
// The three offline audit scripts (replay-call-extraction-variance.js,
// verify-v2-shadow-path.js, v2-promotion-readiness.js) used to pass
// call.customer_id — the persisted link — straight into
// buildFailOpenRoutingContext as the audit's "known customer". Production's
// OWN Step 2 pre-lookup (call-recording-processor.js's knownCustomer
// assignment, ~L8589-8593) does NOT read that column at all: it honors an
// operator relink (call.metadata.customer_link_override) first, and
// otherwise looks the customer up fresh by contact PHONE
// (findCustomerForCallContact(contactPhone, {})). Those two selections can
// disagree — an operator relink since the row was fetched, or (the
// concrete miss this round found) a lead-webhook-auto-bridge row with
// broken metadata: resolveCallContactPhone correctly returns null, and with
// no override findCustomerForCallContact(null, {}) correctly returns null
// too — but the audit's old "read call.customer_id" shortcut kept using the
// stale persisted link and reported an auto-route production would have
// held on caller_phone_missing.
//
// resolveKnownCallerCustomer (exported from call-recording-processor.js)
// replicates that exact selection so the audit scripts reconstruct the SAME
// knownCaller production would have used, not an approximation keyed on a
// column production's own selection doesn't consult.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const {
  resolveKnownCallerCustomer, buildFailOpenRoutingContext, resolveCallContactPhone,
} = CallRecordingProcessor;
const { canAutoRoute } = require('../services/call-triage-flags');

afterEach(() => db.mockReset());

// Same mockDbQueue shape already proven against findCustomerForCallContact
// in call-structural-trio.test.js — reused here rather than re-deriving a
// second convention for the same query builder.
function mockDbQueue(resultsByTable) {
  const queues = { ...resultsByTable };
  db.mockImplementation((table) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      whereNull: () => builder,
      whereNot: () => builder,
      whereRaw: () => builder,
      orWhereRaw: () => builder,
      orderBy: () => builder,
      orderByRaw: () => builder,
      limit: () => builder,
      count: () => builder,
      select: () => builder,
      first: () => Promise.resolve((queues[table] || []).shift() ?? null),
      then: (resolve, reject) => Promise.resolve((queues[table] || []).shift() ?? []).then(resolve, reject),
    };
    return builder;
  });
}

const extraction = (flags) => ({
  triage_flags: flags,
  confidence: { overall: 0.9 },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-07-11T09:00:00-04:00' },
  consent: {},
});

describe('resolveKnownCallerCustomer — the audit context mirrors production\'s live known-caller selection', () => {
  test('a lead-webhook-auto-bridge row with invalid metadata + a persisted customer_id: no override, contactPhone resolves to null → knownCaller is null WITHOUT any DB query, and canAutoRoute holds on caller_phone_missing', async () => {
    const badMetadataCall = {
      customer_id: 'stale-linked-customer', // the persisted link the OLD audit shortcut used to trust
      direction: 'outbound',
      source: 'lead-webhook-auto-bridge',
      from_phone: '+19415551000',
      to_phone: '+19415559999', // staff cell
      metadata: null, // broken — no prospect number recoverable
    };
    const contactPhone = resolveCallContactPhone(badMetadataCall);
    expect(contactPhone).toBeNull();

    // findCustomerForCallContact short-circuits on a falsy phone before
    // touching the DB (phoneKey(null) is falsy) — assert that contract by
    // making any query throw.
    db.mockImplementation(() => { throw new Error('resolveKnownCallerCustomer must not query the DB with no override and no contact phone'); });
    const known = await resolveKnownCallerCustomer(badMetadataCall, contactPhone);
    expect(known).toBeNull();

    // Feed it into buildFailOpenRoutingContext exactly as the fixed audit
    // scripts now do, and confirm the routing decision holds — the persisted
    // customer_id's on-file address never enters the picture.
    const ctx = buildFailOpenRoutingContext({ call: badMetadataCall, customer: known, failOpenEnabled: true });
    expect(ctx.options.knownCustomer).toBeNull();
    const r = canAutoRoute(extraction(['caller_phone_missing']), ctx.options);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_phone_missing');
  });

  test('an explicit unlink override (customer_id: null) means no known caller at all, regardless of a persisted customer_id or a valid contact phone', async () => {
    const call = {
      customer_id: 'stale-linked-customer',
      direction: 'inbound',
      from_phone: '+19415550100',
      metadata: { customer_link_override: { customer_id: null } },
    };
    db.mockImplementation(() => { throw new Error('an explicit unlink must not query the DB'); });
    const known = await resolveKnownCallerCustomer(call, '+19415550100');
    expect(known).toBeNull();
  });

  test('an operator override with a customer_id uses THAT customer, outranking both the persisted customer_id column and the phone lookup', async () => {
    const overrideCustomer = {
      id: 'override-cust', pipeline_stage: 'won',
      address_line1: '9 Override Ln', city: 'Venice', state: 'FL', zip: '34285',
    };
    const call = {
      customer_id: 'stale-linked-customer', // deliberately different — must be ignored
      direction: 'inbound',
      from_phone: '+19415550100',
      metadata: { customer_link_override: { customer_id: 'override-cust' } },
    };
    mockDbQueue({ customers: [overrideCustomer] });
    const known = await resolveKnownCallerCustomer(call, '+19415550100');
    expect(known).toMatchObject({ id: 'override-cust' });
  });

  test('a normal row with no override delegates to findCustomerForCallContact(contactPhone, {}) — the SAME live phone-lookup contract, never the persisted customer_id column', async () => {
    const phoneMatchedCustomer = {
      id: 'phone-cust', phone: '+19415550100', pipeline_stage: 'won',
      address_line1: '1 Match St', city: 'Venice', state: 'FL', zip: '34285',
    };
    const call = {
      customer_id: 'different-persisted-id', // deliberately different from the phone match — must be ignored
      direction: 'inbound',
      from_phone: '+19415550100',
      metadata: {},
    };
    // findCustomerForCallContact's base().orderBy().limit() resolves an array.
    mockDbQueue({ customers: [[phoneMatchedCustomer]] });
    const known = await resolveKnownCallerCustomer(call, '+19415550100');
    expect(known).toMatchObject({ id: 'phone-cust' });
  });

  test('no override, no resolvable phone, NO persisted customer_id either (a genuinely unknown caller) — still null, still no DB query', async () => {
    const call = { direction: 'inbound', from_phone: null, metadata: {} };
    db.mockImplementation(() => { throw new Error('must not query the DB with nothing to look up'); });
    expect(await resolveKnownCallerCustomer(call, null)).toBeNull();
  });
});
