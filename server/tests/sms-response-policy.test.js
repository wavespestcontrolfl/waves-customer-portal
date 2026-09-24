const {
  HUMAN_REPLY_TYPES,
  NON_ACTIONABLE_INBOUND_TYPES,
  draftReplyToMessageIdSql,
  inboundSmsReceiptProjectionSql,
  responseFlags,
  inboundNeedsResponse,
  outboundIsAnswer,
} = require('../services/sms-response-policy');

describe('SMS response policy', () => {
  test('keeps the watcher human-reply and consumed-inbound classifications explicit', () => {
    expect(HUMAN_REPLY_TYPES).toEqual([
      'manual', 'ai_approved', 'ai_revised', 'ai_assistant', 'ai_assistant_reply',
    ]);
    expect(NON_ACTIONABLE_INBOUND_TYPES).toEqual([
      'opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply',
    ]);
  });

  test('canonicalizes a draft anchor only when it has one inbound SMS twin', () => {
    const sql = draftReplyToMessageIdSql('response_draft.sms_log_id');
    expect(sql).toContain('draft_inbound.id = (response_draft.sms_log_id)');
    expect(sql).toContain("draft_inbound.direction = 'inbound'");
    expect(sql).toContain("canonical_inbound.channel = 'sms'");
    expect(sql).toContain("canonical_inbound.direction = 'inbound'");
    expect(sql).toContain('COUNT(canonical_inbound.id) = 1');
  });

  test('projects a durable inbound STOP receipt without replacing canonical privacy types', () => {
    const projection = inboundSmsReceiptProjectionSql({
      messageAlias: 'm', legacyAlias: 'legacy', receiptAlias: 'receipt',
    });
    expect(projection.joinSql).toContain('receipt.message_sid = m.twilio_sid');
    expect(projection.joinSql).toContain("m.channel = 'sms'");
    expect(projection.joinSql).toContain("m.direction = 'inbound'");
    expect(projection.responseMessageTypeSql).toContain("THEN 'opt_out'");
    expect(projection.responseMessageTypeSql).toContain('COALESCE(legacy.message_type, m.message_type)');
    expect(projection.effectiveCreatedAtSql).toContain('LEAST(m.created_at, receipt.applied_at)');
  });

  test.each([
    ['Thanks!', 'Your service is complete. Reply STOP to opt out.', true],
    ['Okay', 'We are on the way. Reply STOP to opt out. Msg & data rates may apply.', true],
    ['Thanks!', 'Does 9am work?', false],
    ['Okay', 'Please confirm someone will be home.', false],
    ['👍', null, false],
    ['Thanks, but you missed the backyard', 'Your service is complete.', false],
    ['Can you come tomorrow?', 'Your service is complete.', false],
    ['Yes', 'Your service is complete.', false],
  ])('classifies unstamped inbound %p from verified prior context', (body, priorOutboundBody, courtesyOnly) => {
    expect(responseFlags({ direction: 'inbound', body, priorOutboundBody })).toMatchObject({ courtesyOnly });
  });

  test('metadata stamps remain authoritative over inferred prior context', () => {
    expect(responseFlags({
      direction: 'inbound',
      body: 'legacy body',
      metadata: JSON.stringify({ courtesyOnly: true, spam_verdict: { enforced: true, score: 0.98 } }),
      priorOutboundBody: 'Does 9am work?',
    })).toEqual({ courtesyOnly: true, spamEnforced: true, hasMedia: false });
    expect(responseFlags({
      direction: 'inbound',
      body: 'Okay',
      metadata: { courtesyOnly: false },
      priorOutboundBody: 'Your service is complete.',
    })).toEqual({ courtesyOnly: false, spamEnforced: false, hasMedia: false });
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
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'ai_approved', status: 'delivered' })).toBe(false);
    expect(outboundIsAnswer({
      direction: 'outbound', messageType: 'ai_approved', status: 'delivered', replyToMessageId: 'inbound-1',
    })).toBe(true);
    expect(outboundIsAnswer({
      direction: 'outbound', messageType: 'ai_revised', status: 'sent', replyToMessageId: 'inbound-1',
    })).toBe(true);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'follow_up', status: 'sent' })).toBe(false);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'reminder', status: 'sent' })).toBe(false);
    expect(outboundIsAnswer({ direction: 'outbound', messageType: 'manual', status: 'failed' })).toBe(false);
  });
});
