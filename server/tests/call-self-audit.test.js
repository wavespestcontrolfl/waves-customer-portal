// Nightly self-audit — auditor-down is a breach, the auditor is blind, and
// every lead-losing terminal disposition counts as drift.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));

const db = require('../models/db');
const { runSelfAudit, stratifySample, OUTBOUND_DIRECTION_SQL } = require('../services/call-self-audit');

const SAMPLE = (over = {}) => ({
  id: 'call-1', twilio_call_sid: 'CA_sa1', created_at: new Date(), processing_status: 'processed',
  transcription: 'Agent: Waves. Caller: I need pest control at my house. '.repeat(8),
  ai_extraction: JSON.stringify({ is_lead: true }), disposition: null, ...over,
});

function mockDb({ calls, onInsert = () => {}, whereCalls = [] }) {
  db.raw = (sql) => sql;
  db.mockImplementation((table) => {
    const raws = [];
    const isOutbound = (c) => String(c.direction || '').startsWith('outbound');
    const b = {
      where(...args) { whereCalls.push(args); return b; }, whereIn() { return b; }, whereRaw(sql) { raws.push(sql); return b; }, modify(fn) { fn(b); return b; },
      orderBy() { return b; }, limit() { return b; },
      // Each direction query returns only its own direction's rows.
      select: async () => {
        if (table !== 'call_log') return [];
        const wantsOutbound = raws.includes(OUTBOUND_DIRECTION_SQL);
        return calls.filter((c) => isOutbound(c) === wantsOutbound);
      },
      insert: (row) => { onInsert(table, row); return { onConflict: () => ({ merge: async () => {}, catch: () => {} }) }; },
    };
    // knex insert().onConflict().merge().catch() chain used in service
    const origInsert = b.insert;
    b.insert = (row) => { const r = origInsert(row); r.merge = async () => {}; return r; };
    return b;
  });
}

beforeEach(() => jest.clearAllMocks());

test('auditor-down (0 audited with calls sampled) is a BREACH, never healthy silence', async () => {
  const alerts = [];
  mockDb({ calls: [SAMPLE(), SAMPLE({ id: 'call-2' })], onInsert: (t, row) => { if (t === 'notifications') alerts.push(row); } });
  const res = await runSelfAudit({ createMessage: async () => { throw new Error('provider down'); } });
  expect(res.audited).toBe(0);
  expect(res.breaches.some((x) => /auditor down/.test(x))).toBe(true);
});

test('the auditor sees ONLY the transcript — production status never leaks into the prompt', async () => {
  let seenPrompt = '';
  mockDb({ calls: [SAMPLE({ processing_status: 'spam' })] });
  await runSelfAudit({ createMessage: async (params) => {
    seenPrompt = params.messages.map((m) => m.content).join(' ');
    return { content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"needs pest control"}' }] };
  } });
  expect(seenPrompt).not.toMatch(/spam|status/i);
  expect(seenPrompt).toContain('Transcript:');
});

test('a lead stamped vendor_logged counts as a disposition mismatch', async () => {
  mockDb({ calls: [SAMPLE({ disposition: 'vendor_logged', ai_extraction: JSON.stringify({ is_lead: true }) })] });
  const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"wants service"}' }] }) });
  expect(res.dispositionRate).toBeGreaterThan(0);
});

// Owner directive 2026-09-26: every call-agent rule is audited the same way
// regardless of who dialed — and a burst of one direction must not crowd the
// other out of the sample (codex #4912 r1 P2).
const OK_VERDICT = { content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"ok"}' }] };

test('outbound calls are sampled even when newer inbound calls alone would fill the sample', async () => {
  const inbound = Array.from({ length: 40 }, (_, i) => SAMPLE({ id: `in-${i}`, direction: 'inbound' }));
  const outboundText = 'Agent: Hi, this is Waves returning your call. Caller: Yes, about the ants. '.repeat(6);
  const outbound = [
    SAMPLE({ id: 'out-1', direction: 'outbound-dial', transcription: outboundText }),
    SAMPLE({ id: 'out-2', direction: 'outbound', transcription: outboundText }),
  ];
  mockDb({ calls: [...inbound, ...outbound] });
  const seen = [];
  await runSelfAudit({ createMessage: async (params) => { seen.push(params.messages[0].content); return OK_VERDICT; } });
  expect(seen.length).toBe(25);
  expect(seen.filter((t) => t.includes('returning your call')).length).toBe(2);
});

test('stratifySample reserves half per direction and gives unused share to the other', () => {
  const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
  const both = stratifySample({ inbound: rows('in', 40), outbound: rows('out', 40), size: 25 });
  expect(both.filter((r) => r.id.startsWith('out')).length).toBe(12);
  expect(both.length).toBe(25);
  const fewOutbound = stratifySample({ inbound: rows('in', 40), outbound: rows('out', 2), size: 25 });
  expect(fewOutbound.filter((r) => r.id.startsWith('out')).length).toBe(2);
  expect(fewOutbound.length).toBe(25);
  const fewInbound = stratifySample({ inbound: rows('in', 3), outbound: rows('out', 40), size: 25 });
  expect(fewInbound.filter((r) => r.id.startsWith('in')).length).toBe(3);
  expect(fewInbound.length).toBe(25);
});
