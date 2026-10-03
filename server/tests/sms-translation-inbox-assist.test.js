// Inbox assist (GATE_SMS_ANY_LANGUAGE_INBOX, owner 2026-10-03): the Communications composer shows the trial's
// translation and checked reply for the customer's LATEST text. Read-only; staff send through the composer.
let mockGateOn = true;
const mockLast = jest.fn();
const mockTrial = jest.fn();
const mockLater = jest.fn();
const mockClaim = jest.fn();
const mockLiveAnswer = jest.fn();
const mockDrafts = jest.fn();
const mockSendChecks = jest.fn();
const mockBoundary = { eta: jest.fn(() => 'eta'), label: jest.fn(() => 'label'), loops: jest.fn(() => undefined), amounts: jest.fn(() => 'amounts') };
jest.mock('../services/agent-decision-send-checks', () => ({
  agentDecisionSendBlockReason: (...a) => mockSendChecks(...a),
  billingFingerprintForSend: async () => 'fp-1',
  etaSnapshotProviderPreSendCheck: (...a) => mockBoundary.eta(...a),
  labelFactsSnapshotProviderPreSendCheck: (...a) => mockBoundary.label(...a),
  openLoopsProviderPreSendCheck: (...a) => mockBoundary.loops(...a),
  amountsProviderPreSendCheck: (...a) => mockBoundary.amounts(...a),
  composeProviderPreSendChecks: () => 'composed-check',
}));
jest.mock('../services/sms-suggest-mode', () => ({ threadHasLiveAnswer: (...a) => mockLiveAnswer(...a) }));

jest.mock('../models/db', () => Object.assign(jest.fn((table) => {
  // sms_log is read twice: the latest inbound (.first) and the outbound rows after it (.select)
  const q = { where: () => q, whereRaw: () => q, whereIn: () => q, whereNot: () => q, whereNotIn: () => q, whereNull: () => q, orWhereNull: () => q, modify: () => q, orderBy: () => q, limit: () => q, select: () => (table === 'message_drafts' ? mockDrafts() : mockLater()), update: (...a) => mockClaim(...a), first: () => (table === 'sms_log' ? mockLast() : mockTrial()) };
  return q;
}), { raw: (...a) => a }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, gateEnvValue: (name) => (name === 'GATE_SMS_ANY_LANGUAGE_INBOX' ? mockGateOn : actual.gateEnvValue(name)) };
});

const { inboxAssistFor, claimTranslationReplyForSend, translationReplySendChecks } = require('../services/sms-translation');

const NOW = new Date('2026-10-03T15:00:00Z');
const READY = {
  id: 7, sms_log_id: 's1', customer_id: 'c1', language: 'Spanish', inbound_original: '¿A qué hora vienen el martes?',
  inbound_english: 'What time are you coming on Tuesday?', reply_english: 'Your visit is Tuesday, Oct 6, 1:00 PM - 3:00 PM.',
  reply_translated: 'Su visita es el martes 6 de oct, 13:00 - 15:00.', verdict: 'ready', hold_reason: null, created_at: new Date('2026-10-03T14:00:00Z'),
  checks: { intended_actions: [{ type: 'none' }], send: { prompt_version: 'house_voice_v12_test', input_snapshot: { facts_generated_at: '2026-10-03T14:00:00.000Z' } } },
};

beforeEach(() => {
  mockGateOn = true;
  mockLast.mockReset(); mockTrial.mockReset(); mockLater.mockReset(); mockClaim.mockReset();
  mockClaim.mockResolvedValue(1);
  mockLiveAnswer.mockReset(); mockLiveAnswer.mockResolvedValue(null);
  mockDrafts.mockReset(); mockDrafts.mockResolvedValue([]);
  mockSendChecks.mockReset(); mockSendChecks.mockResolvedValue(null);
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
    // an action-free reply stored without the snapshot its send-time fact recheck reads is withheld too
    mockTrial.mockResolvedValue({ ...READY, checks: { intended_actions: [] } });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: null, heldReason: words });
    mockTrial.mockResolvedValue({ ...READY, checks: { ...READY.checks, intended_actions: [] } });
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: READY.reply_translated, heldReason: null });
  });

  test('an approved draft after the text is judged from its own draft row: a click follow-up is not an answer', async () => {
    const draftId = '11111111-2222-3333-4444-555555555555';
    mockLater.mockResolvedValue([{ message_type: 'ai_approved', status: 'delivered', to_phone: '+19415550100', metadata: JSON.stringify({ draft_id: draftId }) }]);
    mockDrafts.mockResolvedValue([{ id: draftId, intent: 'click_followup', sms_log_id: null }]);
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: READY.reply_translated });
    // no draft row to anchor it: not an answer either
    mockDrafts.mockResolvedValue([]);
    expect(await inboxAssistFor('c1', NOW)).toMatchObject({ replyTranslated: READY.reply_translated });
    // a reviewed draft that answered an inbound text is
    mockDrafts.mockResolvedValue([{ id: draftId, intent: 'general', sms_log_id: 's1' }]);
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
  });

  test('an international number is matched on its whole identity, and its send guard is scoped by the customer', async () => {
    mockLast.mockResolvedValue({ id: 's1', from_phone: '+449415550100', created_at: new Date('2026-10-03T14:00:00Z') });
    expect(await inboxAssistFor('c1', NOW, '+19415550100')).toBeNull(); // a US thread sharing the last ten digits
    expect(await inboxAssistFor('c1', NOW, '+449415550100')).toMatchObject({ replyTranslated: READY.reply_translated });
    expect(await claimTranslationReplyForSend({ trialId: 7, customerId: 'c1', to: '+449415550100', now: NOW })).toBe('ok');
    expect(mockLiveAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ threadLast10: null, customerId: 'c1' }));
  });

  test('send boundary: the Agent Review send checks re-read the reply\'s facts from the stored snapshot', async () => {
    const ok = await translationReplySendChecks({ trialId: 7, customerId: 'c1' });
    expect(ok.reason).toBeNull();
    expect(mockSendChecks).toHaveBeenCalledWith({
      decision: expect.objectContaining({
        customer_id: 'c1', prompt_version: 'house_voice_v12_test', suggested_message: READY.reply_english, inbound_message: READY.inbound_english,
        input_snapshot: { facts_generated_at: '2026-10-03T14:00:00.000Z', sms: { body: READY.inbound_english } },
      }),
      outgoingBody: READY.reply_english,
    });
    // ...and hands the route the same facts for the provider boundary, built from the snapshot
    expect(mockBoundary.eta).toHaveBeenCalledWith(expect.objectContaining({ factsGeneratedAt: '2026-10-03T14:00:00.000Z', promptVersion: 'house_voice_v12_test' }));
    expect(mockBoundary.amounts).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ billing_fingerprint: 'fp-1' }) }));
    expect(ok.providerPreSendCheck).toBe('composed-check');
    mockSendChecks.mockResolvedValue('open-times stale (slot_taken)');
    expect(await translationReplySendChecks({ trialId: 7, customerId: 'c1' })).toEqual({ reason: 'open-times stale (slot_taken)' });
    // no snapshot, no row, or a failed read: refused
    mockTrial.mockResolvedValue({ ...READY, checks: { intended_actions: [] } });
    expect(await translationReplySendChecks({ trialId: 7, customerId: 'c1' })).toEqual({ reason: 'not_readable' });
    mockTrial.mockResolvedValue(undefined);
    expect(await translationReplySendChecks({ trialId: 7, customerId: 'c1' })).toEqual({ reason: 'not_readable' });
    mockTrial.mockResolvedValue(READY);
    mockSendChecks.mockRejectedValue(new Error('boom'));
    expect(await translationReplySendChecks({ trialId: 7, customerId: 'c1' })).toEqual({ reason: 'recheck_failed' });
  });

  test('no row yet for a recent text: pending, so the composer asks again (15 s at first, then each minute, 15 minutes at most)', async () => {
    mockTrial.mockResolvedValue(undefined);
    const at = (iso) => mockLast.mockResolvedValue({ id: 's2', from_phone: '+19415550100', created_at: new Date(iso) });
    at('2026-10-03T14:58:30Z');
    expect(await inboxAssistFor('c1', NOW)).toEqual({ pending: true, customerId: 'c1', smsLogId: 's2', retryInMs: 15000 });
    at('2026-10-03T14:50:00Z');
    expect(await inboxAssistFor('c1', NOW)).toEqual({ pending: true, customerId: 'c1', smsLogId: 's2', retryInMs: 60000 });
    at('2026-10-03T14:44:00Z');
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
  });

  test('a read failure returns nothing and never logs the message text', async () => {
    mockLast.mockRejectedValue(Object.assign(new Error('select ... Hola secreto'), { code: '57014' }));
    expect(await inboxAssistFor('c1', NOW)).toBeNull();
    expect(require('../services/logger').warn.mock.calls.flat().join(' ')).not.toContain('Hola');
  });
});
