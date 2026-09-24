const { _private: { mapCommsMessage } } = require('../services/customer-history');

test('customer comms exposes narrow SMS response flags without raw metadata', () => {
  const mapped = mapCommsMessage({
    id: 'message-1',
    conversation_id: 'conversation-1',
    channel: 'sms',
    direction: 'inbound',
    body: 'Old courtesy closer',
    media: [],
    metadata: { courtesyOnly: true },
    response_metadata: { spam_verdict: { enforced: true, privateScore: 0.99 } },
    response_message_type: 'sms_reaction', response_status: 'received',
    is_read: true,
    created_at: new Date('2026-09-23T12:00:00Z'),
    our_endpoint_id: '+19415550190',
    contact_phone: '+19415550100',
  }, { phone: '+19415550100' }, null);

  expect(mapped).toMatchObject({
    courtesyOnly: true, spamEnforced: true,
    responseMessageType: 'sms_reaction', responseStatus: 'received',
    responseIsAnswer: false,
  });
  expect(mapped).not.toHaveProperty('metadata');
});

test('customer comms leaves media-bearing courtesy captions actionable', () => {
  const mapped = mapCommsMessage({
    id: 'message-2', conversation_id: 'conversation-1', channel: 'sms', direction: 'inbound',
    body: 'Thanks!', media: [{ type: 'attachment', url: 'synthetic.jpg' }],
    metadata: { courtesyOnly: true }, is_read: false,
    created_at: new Date('2026-09-23T12:00:00Z'),
  }, { phone: '+19415550100' }, null);
  expect(mapped.courtesyOnly).toBe(false);
});

test('customer comms preserves an acknowledgment that answers the prior outbound question', () => {
  const mapped = mapCommsMessage({
    id: 'message-question-answer', conversation_id: 'conversation-1', channel: 'sms', direction: 'inbound',
    body: 'Okay', media: [], metadata: {}, response_prior_outbound_body: 'Does 9am work?',
    created_at: new Date('2026-09-23T12:00:00Z'),
  }, { phone: '+19415550100' }, null);
  expect(mapped.courtesyOnly).toBe(false);
});

test('customer comms retires an unstamped courtesy closer after a verified service update', () => {
  const mapped = mapCommsMessage({
    id: 'message-courtesy', conversation_id: 'conversation-1', channel: 'sms', direction: 'inbound',
    body: 'Thanks!', media: [], metadata: {},
    response_prior_outbound_body: 'Your service is complete. Reply STOP to opt out.',
    created_at: new Date('2026-09-23T12:00:00Z'),
  }, { phone: '+19415550100' }, null);
  expect(mapped.courtesyOnly).toBe(true);
});

test('customer comms maps an audit-linked click followup to a non-answer', () => {
  const mapped = mapCommsMessage({
    id: 'message-3', conversation_id: 'conversation-1', channel: 'sms', direction: 'outbound',
    body: 'Checking in', media: [], metadata: {}, message_type: 'ai_approved', delivery_status: 'sent',
    response_message_type: 'ai_approved', response_status: 'sent', response_is_click_followup: true,
    response_audit_metadata: { draft_id: 'private-draft-id' }, created_at: new Date('2026-09-23T12:00:00Z'),
  }, { phone: '+19415550100' }, null);
  expect(mapped.responseIsAnswer).toBe(false);
  expect(mapped).not.toHaveProperty('metadata');
  expect(mapped).not.toHaveProperty('responseAuditMetadata');
});

test('customer comms requires exact draft provenance before AI approval clears a thread', () => {
  const base = {
    id: 'message-ai-approved', conversation_id: 'conversation-1', channel: 'sms', direction: 'outbound',
    body: 'A human-approved reply', media: [], metadata: {}, message_type: 'ai_approved',
    delivery_status: 'sent', response_message_type: 'ai_approved', response_status: 'sent',
    created_at: new Date('2026-09-23T12:00:00Z'),
  };
  expect(mapCommsMessage(base, { phone: '+19415550100' }, null).responseIsAnswer).toBe(false);
  const linked = mapCommsMessage({
    ...base,
    response_reply_to_message_id: '00000000-0000-4000-8000-000000000001',
    response_created_at: new Date('2026-09-23T11:59:58Z'),
  }, { phone: '+19415550100' }, null);
  expect(linked).toMatchObject({
    responseIsAnswer: true,
    responseReplyToMessageId: '00000000-0000-4000-8000-000000000001',
    responseCreatedAt: new Date('2026-09-23T11:59:58Z'),
    createdAt: new Date('2026-09-23T12:00:00Z'),
  });
});

test('customer comms does not classify a proactive follow-up as an answer', () => {
  const mapped = mapCommsMessage({
    id: 'message-follow-up', conversation_id: 'conversation-1', channel: 'sms', direction: 'outbound',
    body: 'Checking in', media: [], message_type: 'follow_up', delivery_status: 'sent',
    created_at: new Date('2026-09-23T12:00:00Z'),
  }, { phone: '+19415550100' }, null);
  expect(mapped.responseIsAnswer).toBe(false);
  expect(mapped.responseReplyToMessageId).toBeNull();
});

test('customer comms uses durable STOP chronology while preserving the canonical privacy type', () => {
  const canonicalAt = new Date('2026-09-23T12:03:00Z');
  const receiptAt = new Date('2026-09-23T12:01:00Z');
  const mapped = mapCommsMessage({
    id: 'message-delayed-stop', conversation_id: 'conversation-1', channel: 'sms', direction: 'inbound',
    body: 'STOP', media: [], message_type: 'job_applicant_reply', response_message_type: 'opt_out',
    effective_created_at: receiptAt, created_at: canonicalAt,
  }, { phone: '+19415550100' }, null);

  expect(mapped).toMatchObject({
    messageType: 'job_applicant_reply',
    responseMessageType: 'opt_out',
    createdAt: receiptAt,
  });
});
