/**
 * recordCallCommitments({ automationHold }): a call the pipeline holds from every automation (the
 * out-of-area hold) stores a send_reschedule_link promise office-only (kind 'other', no due time),
 * because a live worker texts the caller for an open one. Every other kind is stored as before, and
 * with the option off nothing changes. Real recordCallCommitments, stubbed model pass and database.
 * Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { recordCallCommitments, AUTOMATION_HOLD_KINDS } = require('../services/call-commitments');

const transcript = 'Agent: I will text you the link to move your visit by tomorrow morning. Caller: great. Agent: And I will call you back about the quote on Friday afternoon.';
const linkQuote = 'I will text you the link to move your visit by tomorrow morning';
const callbackQuote = 'I will call you back about the quote on Friday afternoon';
const modelAnswer = JSON.stringify({
  commitments: [
    { party: 'waves', kind: 'send_reschedule_link', description: 'Text the reschedule link', channel: 'sms', due_text: 'tomorrow morning', due_at: '2026-10-30T09:00:00-04:00', due_type: 'deadline', confidence: 0.9, evidence: [{ quote: linkQuote, speaker: 'agent' }] },
    { party: 'waves', kind: 'callback', description: 'Call back about the quote', channel: 'call', due_text: 'Friday afternoon', due_at: '2026-10-30T14:00:00-04:00', due_type: 'deadline', confidence: 0.9, evidence: [{ quote: callbackQuote, speaker: 'agent' }] },
  ],
});

// A live link promise also reads and writes the activation boundary (system_settings) inside the
// same transaction, so the fake answers both tables like a real knex transaction.
const setup = () => {
  const settings = {};
  const raw = jest.fn(async () => ({ rows: [{ id: 'row', now: new Date() }], rowCount: 1 }));
  function trx(table) {
    if (table === 'call_log') return { where: () => ({ forShare: () => ({ first: async () => ({ id: 'c' }) }) }) };
    if (table === 'call_commitments') { // reconcileRescheduleKeys: no earlier link rows
      const q = { where: () => q, whereRaw: () => q, orderBy: () => q, forUpdate: () => q, select: async () => [] };
      return q;
    }
    if (table !== 'system_settings') throw new Error(`unexpected table: ${table}`);
    let key;
    const q = {
      where: (eq) => { key = eq.key; return q; },
      first: async () => (settings[key] !== undefined ? { value: settings[key] } : null),
      insert: (data) => ({ onConflict: () => ({ ignore: async () => { if (!(data.key in settings)) settings[data.key] = data.value; return 1; } }) }),
    };
    return q;
  }
  trx.raw = raw;
  return {
    raw,
    conn: Object.assign(jest.fn(trx), { transaction: async (fn) => fn(trx) }),
    modelClient: { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: modelAnswer }] })) } },
  };
};
const call = { id: 'c', created_at: '2026-10-29T15:00:00Z', transcript_structured: null };
const inserted = (raw) => raw.mock.calls
  .filter(([sql]) => String(sql).includes('INSERT INTO call_commitments'))
  .map(([, b]) => ({ party: b[2], kind: b[3], description: b[4], dueAt: b[6] }));

test('the held kinds are exactly the one with a live sending worker', () => {
  expect([...AUTOMATION_HOLD_KINDS]).toEqual(['send_reschedule_link']);
});

test('option off: both promises are stored as stated, the link with its due time', async () => {
  const { raw, conn, modelClient } = setup();
  await recordCallCommitments({ conn, call, transcript, procToken: 'tok', modelClient });
  const rows = inserted(raw);
  expect(rows.map((r) => r.kind).sort()).toEqual(['callback', 'send_reschedule_link']);
  expect(rows.find((r) => r.kind === 'send_reschedule_link').dueAt).toBeInstanceOf(Date);
});

test('automationHold: the link promise lands as other with no due_at; the callback keeps its kind and due time', async () => {
  const { raw, conn, modelClient } = setup();
  await recordCallCommitments({ conn, call, transcript, procToken: 'tok', modelClient, automationHold: true });
  const rows = inserted(raw);
  expect(rows.map((r) => r.kind).sort()).toEqual(['callback', 'other']);
  const link = rows.find((r) => r.kind === 'other');
  expect(link.party).toBe('waves');
  expect(link.dueAt).toBeNull();
  expect(link.description).toMatch(/reschedule link/i);
  expect(rows.find((r) => r.kind === 'callback').dueAt).toBeInstanceOf(Date);
});
