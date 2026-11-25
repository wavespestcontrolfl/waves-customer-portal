/**
 * A practice line (the GPT-Live trial's brain) decides account access on the
 * attestation its Twilio-SIGNED cell request stamped, never on the call_log row's
 * own stir_verstat, which an unsigned webhook (shared signature validation in
 * log or disabled mode) could rewrite between reads. No network, no database.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockRow;
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereRaw', 'whereNull', 'whereIn', 'select']) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(async () => mockRow());
  chain.update = jest.fn(() => chain);
  chain.returning = jest.fn(async () => [{ id: 1 }]); // the claim is won
  const db = jest.fn(() => chain);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});

jest.mock('../services/voice-agent/relay-context', () => {
  const actual = jest.requireActual('../services/voice-agent/relay-context');
  return { ...actual, resolveCallerContext: jest.fn(async () => null) };
});

const relayContext = require('../services/voice-agent/relay-context');

const row = (stirVerstat) => () => ({
  from_phone: '+19415550100', direction: 'inbound', created_at: new Date(), metadata: { stir_verstat: stirVerstat },
});
const base = { callSid: 'CA-sig-1', from: '+19415550100' };

describe('verifyInboundCaller attestation', () => {
  test('without a signed identity the row decides (every ordinary call, unchanged)', async () => {
    mockRow = row('TN-Validation-Passed-A');
    await expect(relayContext.verifyInboundCaller(base)).resolves.toEqual({ verified: true, attestation: 'TN-Validation-Passed-A' });
  });

  test('a signed identity replaces the row: the row says A, the stamp says C, the call is not attested', async () => {
    mockRow = row('TN-Validation-Passed-A');
    const out = await relayContext.verifyInboundCaller({ ...base, signedIdentity: { attestation: 'TN-Validation-Failed-C' } });
    expect(out).toEqual({ verified: true, attestation: 'TN-Validation-Failed-C' });
    expect(relayContext.isFullAttestation(out.attestation)).toBe(false);
  });

  test('a signed identity with no attestation is unattested even when the row says A', async () => {
    mockRow = row('TN-Validation-Passed-A');
    const out = await relayContext.verifyInboundCaller({ ...base, signedIdentity: { attestation: null } });
    expect(out.attestation).toBe(null);
    expect(relayContext.isFullAttestation(out.attestation)).toBe(false);
  });

  test('a row rewritten to A after the signed request stamped C cannot attest the call (the race)', async () => {
    // The row's value changes between reads; the signed value is the only one used.
    let reads = 0;
    mockRow = () => { reads += 1; return row(reads === 1 ? 'TN-Validation-Failed-C' : 'TN-Validation-Passed-A')(); };
    const first = await relayContext.verifyInboundCaller({ callSid: 'CA-sig-2', from: base.from, signedIdentity: { attestation: 'TN-Validation-Failed-C' } });
    const second = await relayContext.verifyInboundCaller({ callSid: 'CA-sig-2', from: base.from, signedIdentity: { attestation: 'TN-Validation-Failed-C' } });
    expect(first.attestation).toBe('TN-Validation-Failed-C');
    expect(second.attestation).toBe('TN-Validation-Failed-C');
  });

  test('a signed identity does not skip the other checks: a row for another number is still unverified', async () => {
    mockRow = () => ({ from_phone: '+19415559999', direction: 'inbound', created_at: new Date(), metadata: {} });
    await expect(relayContext.verifyInboundCaller({ ...base, signedIdentity: { attestation: 'TN-Validation-Passed-A' } }))
      .resolves.toEqual({ verified: false, reason: 'ani_mismatch' });
  });
});

describe('verifyRelaySession with a signed identity', () => {
  test('row A + stamp C: verified but not attested; row C + stamp A: attested (the stamp wins both ways)', async () => {
    mockRow = row('TN-Validation-Passed-A');
    await expect(relayContext.verifyRelaySession({ ...base, signedIdentity: { attestation: 'TN-Validation-Failed-C' } }))
      .resolves.toEqual({ verified: true, attested: false });
    mockRow = row('TN-Validation-Failed-C');
    await expect(relayContext.verifyRelaySession({ callSid: 'CA-sig-3', from: base.from, signedIdentity: { attestation: 'TN-Validation-Passed-A' } }))
      .resolves.toEqual({ verified: true, attested: true });
  });
});

describe('RelayConversation hands the signed attestation to the verifier, on a practice line only', () => {
  const OLD = process.env.VOICE_RELAY_CONTEXT_ENABLED;
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; relayContext.resolveCallerContext.mockClear(); });
  afterAll(() => {
    if (OLD === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    else process.env.VOICE_RELAY_CONTEXT_ENABLED = OLD;
  });
  const make = (extra) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    return new RelayConversation({ callSid: 'CA-sig-4', from: base.from, send: jest.fn(), sandbox: true, ...extra });
  };

  test('a practice line passes the stamped attestation (null when none) and never the row\'s', () => {
    make({ practiceLine: true, signedAttestation: 'TN-Validation-Failed-C' });
    expect(relayContext.resolveCallerContext.mock.calls[0][1].signedIdentity).toEqual({ attestation: 'TN-Validation-Failed-C' });
    relayContext.resolveCallerContext.mockClear();
    make({ practiceLine: true });
    expect(relayContext.resolveCallerContext.mock.calls[0][1].signedIdentity).toEqual({ attestation: null });
  });

  test('an ordinary session, or a non-sandbox one asking for it, passes none: the row decides as before', () => {
    make({});
    expect(relayContext.resolveCallerContext.mock.calls[0][1].signedIdentity).toBe(null);
    relayContext.resolveCallerContext.mockClear();
    make({ sandbox: false, practiceLine: true, signedAttestation: 'TN-Validation-Passed-A' });
    expect(relayContext.resolveCallerContext.mock.calls[0][1].signedIdentity).toBe(null);
  });
});
