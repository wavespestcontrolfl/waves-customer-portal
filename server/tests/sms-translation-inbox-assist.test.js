// Inbox assist (GATE_SMS_ANY_LANGUAGE_INBOX, owner 2026-10-03): the Communications composer shows the trial's
// translation and checked reply for the customer's LATEST text. Read-only; staff send through the composer.
let mockGateOn = true;
const mockLast = jest.fn();
const mockTrial = jest.fn();
const mockLater = jest.fn();
const mockClaim = jest.fn();

jest.mock('../models/db', () => Object.assign(jest.fn((table) => {
  // sms_log is read twice: the latest inbound (.first) and the outbound rows after it (.select)
  const q = { where: () => q, whereRaw: () => q, whereIn: () => q, whereNot: () => q, whereNotIn: () => q, whereNull: () => q, orWhereNull: () => q, modify: () => q, orderBy: () => q, limit: () => q, select: () => mockLater(), update: (...a) => mockClaim(...a), first: () => (table === 'sms_log' ? mockLast() : mockTrial()) };
  return q;
}), { raw: (...a) => a }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, gateEnvValue: (name) => (name === 'GATE_SMS_ANY_LANGUAGE_INBOX' ? mockGateOn : actual.gateEnvValue(name)) };
});

const { inboxAssistFor, claimTranslationReplyForSend } = require('../services/sms-translation');

const NOW = new Date('2026-10-03T15:00:00Z');
const READY = {
  id: 7, sms_log_id: 's1', customer_id: 'c1', language: 'Spanish', inbound_original: '¿A qué hora vienen el martes?',
  inbound_english: 'What time are you coming on Tuesday?', reply_english: 'Your visit is Tuesday, Oct 6, 1:00 PM - 3:00 PM.',
  reply_translated: 'Su visita es el martes 6 de oct, 13:00 - 15:00.', verdict: 'ready', hold_reason: null, created_at: new Date('2026-10-03T14:00:00Z'),
  checks: { intended_actions: [{ type: 'none' }] },
};

beforeEach(() => {
  mockGateOn = true;
  mockLast.mockReset(); mockTrial.mockReset(); mockLater.mockReset(); mockClaim.mockReset();
  mockClaim.mockResolvedValue(1);
  mockLater.mockResolvedValue([]);
  mockLast.mockResolvedValue({ id: 's1', from_phone: '+19415550100', created_at: new Date('2026-10-03T14:00:00Z') });
  mockTrial.mockResolvedValue(READY);
});

describe('inboxAssistFor', () => {
  test('gate off: nothing, and nothing is read', async () => {
    mockGateOn = false;
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(mockLast).not.toHaveBeenCalled();
  });

  test('a ready answer to the latest text: the translation, the reply in both languages, no hold line', async () => {
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({
      trialId: 7, language: 'Spanish', inboundEnglish: READY.inbound_english, replyEnglish: READY.reply_english, replyTranslated: READY.reply_translated, heldReason: null,
    });
  });

  test('answered = an accepted human reply to that number after the text; a reminder or a failed send is not', async () => {
    mockLater.mockResolvedValue([{ message_type: 'manual', status: 'delivered', to_phone: '+19415550100' }]);
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(mockTrial).not.toHaveBeenCalled();
    // a failed manual send, and a manual text to another number, leave the question open
    mockLater.mockResolvedValue([{ message_type: 'manual', status: 'failed', to_phone: '+19415550100' }, { message_type: 'manual', status: 'sent', to_phone: '+19415550177' }]);
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: READY.reply_translated });
  });

  test('a reply the drafter paired with an action (pay link, booking, hand-off) is withheld; so is a row with no action record', async () => {
    const words = 'The reply promises a follow-up (a link, a booking or a hand-off), so it needs a person.';
    mockTrial.mockResolvedValue({ ...READY, checks: JSON.stringify({ intended_actions: [{ type: 'send_payment_link' }] }) });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ inboundEnglish: READY.inbound_english, replyTranslated: null, heldReason: words });
    mockTrial.mockResolvedValue({ ...READY, checks: null });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: null, heldReason: words });
    mockTrial.mockResolvedValue({ ...READY, checks: { intended_actions: [] } });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: READY.reply_translated, heldReason: null });
  });

  test('send boundary: sendable only while its card would still offer it, and by one sender', async () => {
    const claim = (over = {}) => claimTranslationReplyForSend({ trialId: 7, customerId: 'c1', to: '+19415550100', now: NOW, ...over });
    expect(await claim()).toBe('ok');
    expect(mockClaim).toHaveBeenCalledTimes(1);
    // the guarded UPDATE matched no row: a teammate stamped it inside the last two minutes
    mockClaim.mockResolvedValue(0);
    expect(await claim()).toBe('claimed');
    mockClaim.mockClear(); mockClaim.mockResolvedValue(1);
    expect(await claim({ trialId: 6 })).toBe('stale'); // another text's trial
    expect(await claim({ to: '+19415550177' })).toBe('stale'); // another number
    expect(await claim({ customerId: null })).toBe('stale');
    mockLater.mockResolvedValue([{ message_type: 'manual', status: 'sent', to_phone: '+19415550100' }]);
    expect(await claim()).toBe('stale'); // already answered
    mockLater.mockResolvedValue([]);
    mockTrial.mockResolvedValue({ ...READY, created_at: new Date('2026-10-02T13:00:00Z') });
    expect(await claim()).toBe('stale'); // expired
    expect(mockClaim).not.toHaveBeenCalled(); // nothing stale is ever stamped
    mockTrial.mockResolvedValue(READY);
    mockClaim.mockRejectedValue(Object.assign(new Error('update ... secreto'), { code: '57014' }));
    expect(await claim()).toBe('stale');
  });

  test('no trial row for the latest text (an English writer), or a skipped one: nothing', async () => {
    mockTrial.mockResolvedValue(undefined);
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    mockTrial.mockResolvedValue({ ...READY, verdict: 'skipped', hold_reason: 'reaction' });
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
  });

  test('a held reply: the confirmed English of their text and a plain reason, never the reply', async () => {
    mockTrial.mockResolvedValue({ ...READY, verdict: 'held', hold_reason: 'meaning_changed_in_translation' });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({
      inboundEnglish: READY.inbound_english, replyEnglish: null, replyTranslated: null, heldReason: 'The translated reply did not read back the same as the English.',
    });
  });

  test('an inbound translation that failed its checks is never shown', async () => {
    mockTrial.mockResolvedValue({ ...READY, verdict: 'held', hold_reason: 'meaning_changed_in_inbound_translation', reply_translated: null });
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
  });

  test('a ready reply more than a day old is not offered (it may quote a visit time); the translation still shows', async () => {
    mockTrial.mockResolvedValue({ ...READY, created_at: new Date('2026-10-02T13:00:00Z') });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ inboundEnglish: READY.inbound_english, replyTranslated: null, heldReason: 'The suggested reply is more than a day old.' });
  });

  test('a reply quoting an arrival time in minutes is never offered; the translation still shows', async () => {
    const eta = { ...READY, reply_english: 'Adam is on the way. ETA: 9 minutes.', reply_translated: 'Adam va en camino. ETA: 9 minutos.' };
    mockTrial.mockResolvedValue({ ...eta, created_at: new Date('2026-10-03T14:59:00Z') });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({
      inboundEnglish: READY.inbound_english, replyEnglish: null, replyTranslated: null, replyExpiresAt: null,
      heldReason: 'The reply quotes a live arrival time, so it needs a person.', customerId: 'c1',
    });
    // a bare figure, when the facts it was drafted from carried a live arrival line
    const bare = { ...READY, reply_english: '20 minutes.', reply_translated: '20 minutos.', created_at: new Date('2026-10-03T14:59:00Z') };
    mockTrial.mockResolvedValue({ ...bare, facts_block: 'LIVE STATUS: en route\nLIVE ETA: about 20 minutes (GPS, as of 10:59 AM)' });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: null, heldReason: 'The reply quotes a live arrival time, so it needs a person.' });
    // the same words with no live arrival fact behind them are an ordinary reply
    mockTrial.mockResolvedValue({ ...bare, facts_block: 'VISIT: Tuesday' });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: '20 minutos.', heldReason: null });
  });

  test('only into the thread the text came in on: another To number gets nothing', async () => {
    expect(await inboxAssistFor('c1', NOW, '9415550100')).toMatchObject({ replyTranslated: READY.reply_translated, replyExpiresAt: '2026-10-04T14:00:00.000Z' });
    expect(await inboxAssistFor('c1', NOW, '9415550177')).toBeNull();
    expect(mockTrial).toHaveBeenCalledTimes(1);
  });

  test('no row yet for a text that just arrived: pending for 3 minutes, so the composer asks again', async () => {
    mockTrial.mockResolvedValue(undefined);
    mockLast.mockResolvedValue({ id: 's2', direction: 'inbound', from_phone: '+19415550100', created_at: new Date('2026-10-03T14:58:30Z') });
    expect(await inboxAssistFor('c1', NOW)).toEqual({ pending: true, customerId: 'c1', smsLogId: 's2' });
    mockLast.mockResolvedValue({ id: 's2', direction: 'inbound', from_phone: '+19415550100', created_at: new Date('2026-10-03T14:56:00Z') });
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
  });

  test('a read failure returns nothing and never logs the message text', async () => {
    mockLast.mockRejectedValue(Object.assign(new Error('select ... Hola secreto'), { code: '57014' }));
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(require('../services/logger').warn.mock.calls.flat().join(' ')).not.toContain('Hola');
  });
});
