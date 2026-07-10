// Nightly self-audit — auditor-down is a breach, the auditor is blind, and
// every lead-losing terminal disposition counts as drift.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));

const db = require('../models/db');
const { runSelfAudit } = require('../services/call-self-audit');

const SAMPLE = (over = {}) => ({
  id: 'call-1', twilio_call_sid: 'CA_sa1', created_at: new Date(), processing_status: 'processed',
  transcription: 'Agent: Waves. Caller: I need pest control at my house. '.repeat(8),
  ai_extraction: JSON.stringify({ is_lead: true }), disposition: null, ...over,
});

function mockDb({ calls, onInsert = () => {} }) {
  db.raw = (sql) => sql;
  db.mockImplementation((table) => {
    const b = {
      where() { return b; }, whereIn() { return b; }, whereRaw() { return b; },
      orderBy() { return b; }, limit() { return b; },
      select: async () => (table === 'call_log' ? calls : []),
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
