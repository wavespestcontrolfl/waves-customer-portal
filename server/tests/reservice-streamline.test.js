/**
 * Re-service request streamline (owner ruling 2026-08-08) — the {reservice_line}
 * clause and shared eligibility helper stay fail-closed:
 *   - '' / null while GATE_RESERVICE_STREAMLINE is dark (todays renders are
 *     byte-identical), regardless of the self-serve gate underneath;
 *   - '' / null for lane-less, inactive, token-less, or missing customers;
 *   - the clause + token payload only when BOTH gates are lit and the live
 *     plan grants a lane;
 *   - never throws (an unsupplied {reservice_line} suppresses the whole SMS,
 *     so every failure mode must resolve to a string).
 * Plus the confirmation-copy migration contract: the sentence swap targets the
 * VERBATIM prod sentence that defeated 20260715220000's whole-body guard.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const gateState = { reserviceStreamline: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => (name in gateState ? gateState[name] : true)),
}));

const scheduler = {
  selfServe: true,
  lanes: ['pest'],
  lanesError: null,
};
jest.mock('../services/reservice-scheduler', () => ({
  reserviceSelfServeEnabled: jest.fn(() => scheduler.selfServe),
  reserviceLanesForCustomer: jest.fn(async () => {
    if (scheduler.lanesError) throw scheduler.lanesError;
    return scheduler.lanes;
  }),
}));

jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (longUrl) => longUrl),
}));

const customerRows = {};
jest.mock('../models/db', () => {
  const mkChain = () => {
    const q = {};
    for (const m of ['where', 'whereNull', 'select']) q[m] = () => q;
    q.first = async () => (customerRows.row !== undefined ? customerRows.row : null);
    return q;
  };
  return jest.fn(() => mkChain());
});

const {
  reserviceLineForCustomer,
  reserviceStreamlineAccess,
  reserviceFollowupLineFor,
} = require('../services/reservice-link');

const liveCustomer = () => ({
  id: 'cu-1', active: true, waveguard_tier: 'Gold', monthly_rate: 89,
  reservice_token: 'a'.repeat(64),
});

beforeEach(() => {
  jest.clearAllMocks();
  gateState.reserviceStreamline = true;
  scheduler.selfServe = true;
  scheduler.lanes = ['pest'];
  scheduler.lanesError = null;
  customerRows.row = liveCustomer();
});

describe('reserviceStreamlineAccess', () => {
  test('grants token + lanes when both gates are lit and a lane is granted', async () => {
    const access = await reserviceStreamlineAccess('cu-1');
    expect(access).toEqual({ token: 'a'.repeat(64), lanes: ['pest'] });
  });

  test('null while GATE_RESERVICE_STREAMLINE is dark — the flip is the launch', async () => {
    gateState.reserviceStreamline = false;
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
  });

  test('null while the underlying self-serve gate is dark', async () => {
    scheduler.selfServe = false;
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
  });

  test('null for a lane-less plan (mosquito-only / lapsed stay office calls)', async () => {
    scheduler.lanes = [];
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
  });

  test('null for inactive, token-less, or missing customers', async () => {
    customerRows.row = { ...liveCustomer(), active: false };
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
    customerRows.row = { ...liveCustomer(), reservice_token: null };
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
    customerRows.row = null;
    expect(await reserviceStreamlineAccess('cu-1')).toBeNull();
    expect(await reserviceStreamlineAccess(null)).toBeNull();
  });

  test('never throws — a lane lookup failure resolves null, not an exception', async () => {
    scheduler.lanesError = new Error('boom');
    await expect(reserviceStreamlineAccess('cu-1')).resolves.toBeNull();
  });
});

describe('reserviceLineForCustomer', () => {
  test('renders the follow-up clause with the standing link when granted', async () => {
    const line = await reserviceLineForCustomer('cu-1');
    expect(line).toContain('book a free re-service');
    expect(line).toContain(`/reservice/${'a'.repeat(64)}`);
    expect(line.endsWith('\n\n')).toBe(true);
  });

  test("'' while the streamline gate is dark — template renders byte-identical", async () => {
    gateState.reserviceStreamline = false;
    expect(await reserviceLineForCustomer('cu-1')).toBe('');
  });

  test("'' for lane-less plans and missing customers — never a bare URL, never undefined", async () => {
    scheduler.lanes = [];
    expect(await reserviceLineForCustomer('cu-1')).toBe('');
    customerRows.row = null;
    expect(await reserviceLineForCustomer('cu-1')).toBe('');
    expect(await reserviceLineForCustomer(undefined)).toBe('');
  });

  test('clause helper contract: empty for no URL (clause-var idiom)', () => {
    expect(reserviceFollowupLineFor(null)).toBe('');
    expect(reserviceFollowupLineFor('')).toBe('');
    expect(reserviceFollowupLineFor('https://x/y')).toBe('If a covered issue comes back, book a free re-service: https://x/y\n\n');
  });
});

describe('service_request_confirmation copy migration (20260808020000)', () => {
  const migration = require('../models/migrations/20260808020000_service_request_confirmation_copy');

  test('targets the verbatim prod sentence that defeated the 20260715220000 whole-body guard', () => {
    // Prod body verified read-only 2026-08-08: "We got your {category} request
    // and will review it within {response_time}. We'll text you once it's
    // assigned to a technician."
    expect(migration.OLD_SENTENCE).toBe("We'll text you once it's assigned to a technician.");
    const prior = require('../models/migrations/20260715220000_service_request_followup_copy');
    // The earlier attempt's guard body does NOT contain this sentence — that
    // mismatch is exactly why the promise survived it.
    expect(prior.OLD_BODY).not.toContain(migration.OLD_SENTENCE);
    // …but it DOES contain the legacy sentence form, which a variant row can
    // still carry (the house-voice sweep only rewrote sms_templates) — the
    // migration retires both forms.
    expect(prior.OLD_BODY).toContain(migration.OLD_SENTENCE_LEGACY);
  });

  test('replacement promises follow-up without inventing an assignment text', () => {
    expect(migration.NEW_SENTENCE).not.toMatch(/text you|assigned to a technician/i);
    expect(migration.NEW_SENTENCE).toMatch(/follow up/i);
  });
});
