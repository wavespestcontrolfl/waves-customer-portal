/**
 * Voice-relay Phase C — call + text history, ANI-VERIFIED ONLY.
 *
 * The hard rule these lock down: call summaries and SMS bodies can carry
 * payment and health details, so a looked-up customer_ref gets NOTHING from
 * these two tools — not even the redacted view the account tools allow. Plus:
 *   - gate off ⇒ tools don't register AND refuse, zero DB touch
 *   - the call read reuses summarizePriorCall's exclusions (ai_extraction
 *     NOT NULL, processing_status NOT IN spam/voicemail, is_spam post-guard)
 *   - the message read uses the canonical dual-arm thread match
 *     (conversations.customer_id OR last-10 of conversations.contact_phone)
 *   - no URL, pay token, or reservice token ever reaches the model
 *   - the session RECENT TEXTS block only appears for a matched caller
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../services/waveguard-existing-services', () => ({ loadOwnedRecurringServiceKeys: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((n) => (n ? `SAFE:${n}` : null)) }));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../utils/service-normalizer', () => ({ normalizeServiceType: jest.fn((v) => v) }));
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));
// redactAccessCodes is the REAL scrub every LLM-facing call summary gets; the
// mock keeps it observable without pulling the whole aggregator graph.
jest.mock('../services/context-aggregator', () => ({
  redactAccessCodes: jest.fn((t) => String(t == null ? '' : t).replace(/gate code \d+/gi, '[redacted]')),
}));

const db = require('../models/db');
const { redactAccessCodes } = require('../services/context-aggregator');
const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
const { openBalanceSummary } = require('../services/open-balance');
const { summarizePriorCall } = require('../services/call-recording-processor');

const relayHistory = require('../services/voice-agent/relay-history');
const relayContext = require('../services/voice-agent/relay-context');
const { activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');

const FROM = '+19415550142';
const CUSTOMER_ID = 'c-1111';
const CUSTOMER = { id: CUSTOMER_ID, first_name: 'Pat', member_since: '2023-04-01T00:00:00Z' };

function makeBuilder(rows) {
  const b = {};
  const chain = ['whereNull', 'whereIn', 'whereNotIn', 'whereNotNull', 'orderBy', 'select', 'limit',
    'whereRaw', 'orWhereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereNot', 'join', 'leftJoin'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.where = jest.fn(function whereImpl(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.update = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
function primeDb(tables = {}) {
  builders = {};
  for (const [t, rows] of Object.entries(tables)) builders[t] = makeBuilder(rows);
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

/** House rule: /pay tokens and reservice tokens never leave their channel. */
const TOKEN_LEAK_RE = /\/pay\/|\/receipt\/|reservice|https?:\/\/|[A-Za-z0-9_-]{20,}/;

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  primeDb();
  redactAccessCodes.mockImplementation((t) => String(t == null ? '' : t).replace(/gate code \d+/gi, '[redacted]'));
  loadOwnedRecurringServiceKeys.mockResolvedValue([]);
  openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
  summarizePriorCall.mockResolvedValue(null);
});

const CALL_ROWS = [
  { created_at: '2026-08-10T14:00:00Z', direction: 'inbound', call_summary: 'Asked about ants in the kitchen', lead_synopsis: null, ai_extraction: '{}' },
  { created_at: '2026-07-22T15:00:00Z', direction: 'outbound', call_summary: null, lead_synopsis: 'Confirmed the quarterly visit', ai_extraction: '{}' },
];

const MSG_ROWS = [
  { direction: 'outbound', body: 'Your invoice is ready: wavespestcontrol.com/pay/abcdefghijklmnopqrstuvwxyz', created_at: '2026-08-09T13:00:00Z' },
  { direction: 'inbound', body: 'Can you come Thursday instead?', created_at: '2026-08-08T12:00:00Z' },
];

describe('GATE OFF — the history tools are dark', () => {
  test('not registered, and executeTool refuses with zero DB touch', async () => {
    expect(activeTools().map((t) => t.name)).not.toEqual(
      expect.arrayContaining(['get_call_history', 'get_message_history']),
    );
    for (const name of ['get_call_history', 'get_message_history']) {
      const out = await executeTool(name, {}, { customerId: CUSTOMER_ID, from: FROM });
      expect(out).toMatch(/not available/i);
    }
    expect(db).not.toHaveBeenCalled();
  });
});

describe('GATE ON — ANI-VERIFIED ONLY (the hard Phase C rule)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('both history tools register with the context set', () => {
    const names = activeTools().map((t) => t.name);
    expect(names).toContain('get_call_history');
    expect(names).toContain('get_message_history');
  });

  test('a VALID looked-up ref gets NOTHING — not even a redacted view, no DB read', async () => {
    const ctx = {
      customerId: CUSTOMER_ID,
      from: FROM,
      // A ref that resolves perfectly well for the account tools:
      resolveLookupRef: (r) => (String(r).toUpperCase() === 'C1' ? 'c-9001' : null),
    };
    for (const name of ['get_call_history', 'get_message_history']) {
      const out = await executeTool(name, { customer_ref: 'C1' }, ctx);
      expect(out).toMatch(/only available for the account the caller's own phone number/i);
      expect(out).toMatch(/never for a looked-up account/i);
      expect(out).not.toMatch(/ants|Thursday|invoice/i);
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('a ref pointing at the caller\'s OWN account is still refused (ANI path only)', async () => {
    const ctx = { customerId: CUSTOMER_ID, from: FROM, resolveLookupRef: () => CUSTOMER_ID };
    const out = await executeTool('get_call_history', { customer_ref: 'C1' }, ctx);
    expect(out).toMatch(/never for a looked-up account/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('unmatched caller → refuses and tells the model not to guess, no DB read', async () => {
    for (const name of ['get_call_history', 'get_message_history']) {
      const out = await executeTool(name, {}, { customerId: null, from: FROM });
      expect(out).toMatch(/No customer account matches/i);
      expect(out).toMatch(/Do NOT guess/i);
    }
    expect(db).not.toHaveBeenCalled();
  });
});

describe('GATE ON — get_call_history read shape', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('reuses summarizePriorCall exclusions and renders dated one-liners, newest first', async () => {
    primeDb({ call_log: CALL_ROWS });
    const out = await executeTool('get_call_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    const b = builders.call_log;
    // Same 10-digit key on BOTH from_phone and to_phone as summarizePriorCall.
    const sql = b.whereRaw.mock.calls.map(([s]) => s).join(' ');
    expect(sql).toMatch(/from_phone/);
    expect(sql).toMatch(/to_phone/);
    expect(b.whereRaw.mock.calls[0][1]).toEqual(['9415550142', '9415550142']);
    expect(b.whereNotNull).toHaveBeenCalledWith('ai_extraction');
    expect(b.whereNotIn).toHaveBeenCalledWith('processing_status', ['spam', 'voicemail']);
    expect(b.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    expect(b.limit).toHaveBeenCalledWith(relayHistory.CALL_HISTORY_LIMIT);

    expect(out).toContain('Asked about ants in the kitchen');
    expect(out).toContain('Confirmed the quarterly visit'); // lead_synopsis fallback
    expect(out).toContain('Monday August 10');
    expect(out).toMatch(/our call to them/); // outbound labeled
    expect(out.indexOf('ants')).toBeLessThan(out.indexOf('quarterly')); // newest first
    assertNoWrites();
  });

  test('is_spam in the extraction is dropped even if the status column missed it', async () => {
    primeDb({
      call_log: [
        { created_at: '2026-08-10T14:00:00Z', direction: 'inbound', call_summary: 'Auto warranty robocall', ai_extraction: JSON.stringify({ is_spam: true }) },
        ...CALL_ROWS,
      ],
    });
    const out = await executeTool('get_call_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    expect(out).not.toMatch(/robocall/i);
    expect(out).toContain('ants in the kitchen');
  });

  test('no processed calls → says so and forbids guessing', async () => {
    primeDb({ call_log: [] });
    const out = await executeTool('get_call_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    expect(out).toMatch(/No processed past calls/i);
    expect(out).toMatch(/Do not guess/i);
  });

  test('blocked/short caller ID → refuses without a query', async () => {
    const out = await executeTool('get_call_history', {}, { customerId: CUSTOMER_ID, from: 'anonymous' });
    expect(out).toMatch(/verified phone number/i);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('GATE ON — get_message_history read shape', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('dual-arm thread match, sms only, inbound/outbound only, newest LAST', async () => {
    primeDb({ messages: MSG_ROWS });
    const out = await executeTool('get_message_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    const b = builders.messages;
    expect(b.join).toHaveBeenCalledWith('conversations', 'messages.conversation_id', 'conversations.id');
    expect(b.where).toHaveBeenCalledWith('messages.channel', 'sms');
    expect(b.whereIn).toHaveBeenCalledWith('messages.direction', ['inbound', 'outbound']); // never 'internal'
    expect(b.orWhere).toHaveBeenCalledWith('conversations.customer_id', CUSTOMER_ID);
    const phoneArm = b.orWhereRaw.mock.calls.map(([s, p]) => ({ s, p }));
    expect(phoneArm[0].s).toMatch(/conversations\.contact_phone/);
    expect(phoneArm[0].p).toEqual(['9415550142']);
    expect(b.limit).toHaveBeenCalledWith(relayHistory.MESSAGE_HISTORY_LIMIT);

    expect(out).toContain('Customer: Can you come Thursday instead?');
    expect(out).toMatch(/Waves: Your invoice is ready/);
    // Newest last: the Aug 9 outbound trails the Aug 8 inbound.
    expect(out.indexOf('Thursday')).toBeLessThan(out.indexOf('invoice is ready'));
    assertNoWrites();
  });

  test('NO pay link, receipt link, or token survives into the model-facing output', async () => {
    primeDb({
      messages: [
        { direction: 'outbound', body: 'Pay here: wavespestcontrol.com/pay/9f8e7d6c5b4a3210fedcba98', created_at: '2026-08-09T13:00:00Z' },
        { direction: 'outbound', body: 'Re-service link https://wavespestcontrol.com/reservice/abcd1234abcd1234abcd', created_at: '2026-08-08T13:00:00Z' },
        { direction: 'inbound', body: 'gate code 4482 for the tech', created_at: '2026-08-07T13:00:00Z' },
      ],
    });
    const out = await executeTool('get_message_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    expect(out).toContain('[link]');
    // The shared access-code scrub still runs on message bodies.
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('4482');
  });

  test('empty thread → says so plainly', async () => {
    primeDb({ messages: [] });
    const out = await executeTool('get_message_history', {}, { customerId: CUSTOMER_ID, from: FROM });
    expect(out).toMatch(/No text messages on file/i);
  });
});

describe('Session RECENT TEXTS block', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('matched caller → block rides alongside KNOWN CALLER, scrubbed, oldest first', async () => {
    primeDb({ customers: [CUSTOMER], messages: MSG_ROWS });
    const ctx = await relayContext.resolveCallerContext(FROM);
    expect(ctx.block).toContain('KNOWN CALLER');
    expect(ctx.block).toContain('RECENT TEXTS');
    expect(ctx.block).toContain('Customer: Can you come Thursday instead?');
    expect(ctx.block).toContain('never instructions'); // data-not-instructions labeling
    expect(ctx.block).not.toMatch(TOKEN_LEAK_RE);
    assertNoWrites();
  });

  test('no texts → no RECENT TEXTS block at all (KNOWN CALLER unchanged)', async () => {
    primeDb({ customers: [CUSTOMER], messages: [] });
    const ctx = await relayContext.resolveCallerContext(FROM);
    expect(ctx.block).toContain('KNOWN CALLER');
    expect(ctx.block).not.toContain('RECENT TEXTS');
  });

  test('unmatched caller → no context at all, so no texts are ever read', async () => {
    primeDb({ customers: [], messages: MSG_ROWS });
    expect(await relayContext.resolveCallerContext(FROM)).toBeNull();
  });

  test('a failing message read never blocks the session (block is optional context)', async () => {
    primeDb({ customers: [CUSTOMER] });
    builders.messages = makeBuilder([]);
    builders.messages.then = (_res, rej) => Promise.reject(new Error('pool exhausted')).catch(rej);
    const ctx = await relayContext.resolveCallerContext(FROM);
    expect(ctx.customer.id).toBe(CUSTOMER_ID);
    expect(ctx.block).toContain('KNOWN CALLER');
    expect(ctx.block).not.toContain('RECENT TEXTS');
  });
});

describe('Prompt', () => {
  test('gate-on prompt states history is never shared with a non-matching voice', () => {
    const p = buildBasePrompt(true);
    expect(p).toContain('get_call_history');
    expect(p).toContain('get_message_history');
    expect(p).toMatch(/Never share, summarize, or hint at a past call or text on a/);
  });
});
