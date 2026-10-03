// Inbox assist (GATE_SMS_ANY_LANGUAGE_INBOX, owner 2026-10-03): the Communications composer shows the trial's
// translation and checked reply for the customer's LATEST text. Read-only; staff send through the composer.
let mockGateOn = true;
const mockLast = jest.fn();
const mockTrial = jest.fn();

jest.mock('../models/db', () => jest.fn((table) => {
  const q = { where: () => q, whereRaw: () => q, orderBy: () => q, limit: () => q, first: () => (table === 'sms_log' ? mockLast() : mockTrial()) };
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, gateEnvValue: (name) => (name === 'GATE_SMS_ANY_LANGUAGE_INBOX' ? mockGateOn : actual.gateEnvValue(name)) };
});

const { inboxAssistFor } = require('../services/sms-translation');

const NOW = new Date('2026-10-03T15:00:00Z');
const READY = {
  id: 7, sms_log_id: 's1', customer_id: 'c1', language: 'Spanish', inbound_original: '¿A qué hora vienen el martes?',
  inbound_english: 'What time are you coming on Tuesday?', reply_english: 'Your visit is Tuesday, Oct 6, 1:00 PM - 3:00 PM.',
  reply_translated: 'Su visita es el martes 6 de oct, 13:00 - 15:00.', verdict: 'ready', hold_reason: null, created_at: new Date('2026-10-03T14:00:00Z'),
};

beforeEach(() => {
  mockGateOn = true;
  mockLast.mockReset(); mockTrial.mockReset();
  mockLast.mockResolvedValue({ id: 's1', direction: 'inbound', created_at: new Date('2026-10-03T14:00:00Z') });
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

  test('somebody already answered (the last message is ours): nothing', async () => {
    mockLast.mockResolvedValue({ id: 'o9', direction: 'outbound', created_at: new Date() });
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(mockTrial).not.toHaveBeenCalled();
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

  test('a reply quoting an arrival time in minutes is offered for 15 minutes only', async () => {
    const eta = { ...READY, reply_english: 'Adam is on the way. ETA: 9 minutes.', reply_translated: 'Adam va en camino. ETA: 9 minutos.' };
    mockTrial.mockResolvedValue({ ...eta, created_at: new Date('2026-10-03T14:50:00Z') });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: eta.reply_translated, heldReason: null, customerId: 'c1' });
    mockTrial.mockResolvedValue({ ...eta, created_at: new Date('2026-10-03T14:40:00Z') });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: null, heldReason: 'The arrival time in the suggested reply is out of date.' });
  });

  test('a read failure returns nothing and never logs the message text', async () => {
    mockLast.mockRejectedValue(Object.assign(new Error('select ... Hola secreto'), { code: '57014' }));
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(require('../services/logger').warn.mock.calls.flat().join(' ')).not.toContain('Hola');
  });
});
