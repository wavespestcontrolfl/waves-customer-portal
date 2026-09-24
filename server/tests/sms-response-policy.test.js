const {
  HUMAN_REPLY_TYPES,
  NON_ACTIONABLE_INBOUND_TYPES,
  responseFlags,
  inboundNeedsResponse,
  outboundIsAnswer,
} = require('../services/sms-response-policy');

describe('SMS response policy', () => {
  test('keeps the watcher human-reply and consumed-inbound classifications explicit', () => {
    expect(HUMAN_REPLY_TYPES).toEqual([
      'manual', 'ai_approved', 'ai_revised', 'ai_assistant', 'ai_assistant_reply', 'follow_up',
    ]);
    expect(NON_ACTIONABLE_INBOUND_TYPES).toEqual([
      'opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply',
    ]);
  });

  test.each([
    ['Thanks!', true],
    ['Okay', true],
    ['Thanks, but you missed the backyard', false],
    ['Can you come tomorrow?', false],
    ['Yes', false],
  ])('classifies historical inbound %p with the shared courtesy grammar', (body, courtesyOnly) => {
    expect(responseFlags({ direction: 'inbound', body })).toMatchObject({ courtesyOnly });
  });

  test('metadata stamps retire courtesy and enforced spam without exposing raw metadata', () => {
    expect(responseFlags({
      direction: 'inbound',
      body: 'legacy body',
      metadata: JSON.stringify({ courtesyOnly: true, spam_verdict: { enforced: true, score: 0.98 } }),
    })).toEqual({ courtesyOnly: true, spamEnforced: true, hasMedia: false });
    expect(inboundNeedsResponse({
      direction: 'inbound', body: 'legacy body', metadata: { spam_verdict: { enforced: true } },
    })).toBe(false);
  });

  test('an attachment stays actionable even with a courtesy caption or stale enforcement stamp', () => {
    const message = {
      direction: 'inbound',
      body: 'Thanks!',
      metadata: { courtesyOnly: true, spam_verdict: { enforced: true }, media: [{ url: 'synthetic.jpg' }] },
    };
    expect(responseFlags(message)).toEqual({ courtesyOnly: false, spamEnforced: false, hasMedia: true });
    expect(inboundNeedsResponse(message)).toBe(true);
  });

  test('outbound rows never serialize as inbound courtesy or spam state', () => {
    expect(responseFlags({
      direction: 'outbound', body: 'Thanks!', metadata: { courtesyOnly: true, spam_verdict: { enforced: true } },
    })).toEqual({ courtesyOnly: false, spamEnforced: false, hasMedia: false });
  });

  test('only accepted conversational outbound sends answer a thread', () => {
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'manual', status: 'sent' })).toBe(true);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'ai_approved', status: 'delivered', isClickFollowup: true })).toBe(false);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'reminder', status: 'sent' })).toBe(false);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'manual', status: 'failed' })).toBe(false);
  });
});
