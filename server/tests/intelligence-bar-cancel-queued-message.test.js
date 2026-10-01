// cancel_queued_message / list_queued_messages — fast, no-DB unit coverage.
// SMS-ONLY (owner ruling 2026-09-28): an email_messages 'queued' row is an
// in-flight send, not a scheduled email — cancelling it always races the
// sender. Real end-to-end CAS behavior (list only scheduled, cancel exactly
// one, refuse a sent/sending message, refuse a changed scheduled_for/body,
// the shared SMS cancel workflow's own reconciliation) is covered against
// real PostgreSQL in intelligence-bar-cancel-queued-message-postgres.test.js,
// which skips cleanly without DATABASE_URL.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduled-sms-cancel', () => ({
  cancelScheduledSmsRow: jest.fn(),
  PRIOR_ATTEMPT_KEY_RE: jest.requireActual('../services/scheduled-sms-cancel').PRIOR_ATTEMPT_KEY_RE,
  SIMPLE_SMS_META_KEYS: jest.requireActual('../services/scheduled-sms-cancel').SIMPLE_SMS_META_KEYS,
}));

const db = require('../models/db');
const { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { cancelScheduledSmsRow } = require('../services/scheduled-sms-cancel');
const { isDeferredReplayEntryPoint, TERMINAL_HOOK_ENTRY_POINTS, requiresTerminalHook } = require('../services/messaging/deferred-replay-registry');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
// Synthetic uuid per index — the queue cursor validates ids as uuids.
const msgId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const STAFF_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ROW = { id: CUSTOMER_ID, first_name: 'Synthetic', last_name: 'Fixture' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('registration: cancel_queued_message is a two-step write, list_queued_messages is a read-only tool, and both are SMS-only', () => {
  expect(WRITE_TWO_STEP_TOOL_NAMES.has('cancel_queued_message')).toBe(true);
  const cancelTool = COMMS_TOOLS.find((t) => t.name === 'cancel_queued_message');
  expect(cancelTool).toBeDefined();
  expect(cancelTool._sideEffects).not.toBe(true); // preview-only until confirmed, like the other two-step tools
  expect(Object.keys(cancelTool.input_schema.properties)).not.toContain('confirmed');
  expect(cancelTool.input_schema.properties.message_id.format).toBe('uuid');
  expect(cancelTool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(cancelTool.input_schema.properties.channel.enum).toEqual(['sms']);
  expect(cancelTool.input_schema.required).toEqual(['message_id', 'customer_id', 'channel']);

  const listTool = COMMS_TOOLS.find((t) => t.name === 'list_queued_messages');
  expect(listTool).toBeDefined();
  expect(listTool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(listTool.input_schema.properties.channel.enum).toEqual(['sms']);
  expect(COMMS_READ_TOOLS.map((t) => t.name)).toContain('list_queued_messages');
  expect(COMMS_READ_TOOLS.map((t) => t.name)).not.toContain('cancel_queued_message');
});

test('rejects a malformed message_id/customer_id before touching the database, and rejects channel "email" as an unsupported channel', async () => {
  const badId = await executeCommsTool('cancel_queued_message', { message_id: 'not-a-uuid', customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(badId.error).toMatch(/resolve/i);

  const badChannel = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'fax' });
  expect(badChannel.error).toMatch(/channel/i);

  // Codex round 2 on #5224: email is no longer a valid channel at all —
  // the tool must reject it explicitly, not silently treat it as sms.
  const emailChannel = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'email' });
  expect(emailChannel.error).toMatch(/channel must be "sms"/i);
  expect(emailChannel.error).toMatch(/emails send within seconds/i);

  expect(db).not.toHaveBeenCalled();
});

test('a preview read failure refuses — it never falls through as "nothing queued"', async () => {
  db.mockImplementation(() => { throw new Error('connection reset by peer'); });
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toBeTruthy();
  expect(out.success).not.toBe(true);
  expect(out.proposal).not.toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

test('an unconfirmed call never reaches the cancel workflow', async () => {
  // Row not found is enough to prove the preview path never commits —
  // real "found and eligible" preview behavior is proven end to end
  // against Postgres.
  const builder = { where: () => builder, first: () => Promise.resolve(undefined) };
  db.mockImplementation(() => builder);
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/could not be found/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

test('confirmed:true with no pinned _verified_message_version refuses instead of committing', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic reminder body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
  };
  const builder = { where: () => builder, first: () => Promise.resolve(row) };
  db.mockImplementation((table) => (table === 'customers' ? { where: () => ({ first: () => Promise.resolve(undefined) }) } : builder));
  const out = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
  });
  expect(out.error).toMatch(/confirmation card/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

test('a message resolved for a different customer refuses before it ever reaches confirmed', async () => {
  const otherCustomer = '33333333-3333-4333-8333-333333333333';
  const row = {
    id: MESSAGE_ID, customer_id: otherCustomer, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic reminder body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
  };
  const builder = { where: () => builder, first: () => Promise.resolve(row) };
  db.mockImplementation((table) => (table === 'customers' ? { where: () => ({ first: () => Promise.resolve({ first_name: 'Synthetic', last_name: 'Fixture' }) }) } : builder));
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/does not belong to the named customer/i);
});

test('list_queued_messages refuses "customer not found" instead of an empty list for an unresolved customer', async () => {
  const builder = { where: () => builder, first: () => Promise.resolve(undefined) };
  db.mockImplementation(() => builder);
  const out = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID });
  expect(out.error).toMatch(/customer not found/i);
});

// A db mock covering the two tables these tools ever touch: `customers`
// (resolveCustomer/customerDisplayName) answers via `.first()`; `sms_log`
// answers `.select()` (list — honors .limit() and the keyset cursor
// against matchRows, so the pagination cap is genuinely exercised) or
// `.first()` (preview) with `matchRows`. matchRows must already be in
// (scheduled_for, id) order, as the real ORDER BY returns them.
function makeSmsDbMock(matchRows) {
  const customersQ = { where: () => customersQ, first: () => Promise.resolve(CUSTOMER_ROW) };
  let limitN = null;
  let after = null;
  const smsQ = {
    where: () => smsQ,
    modify: (fn, arg) => { fn(smsQ, arg); return smsQ; },
    // The keyset cursor predicate: record its (scheduled_for, id) bindings.
    whereRaw: (_sql, b) => { after = { sf: b[0], id: b[1] }; return smsQ; },
    orderBy: () => smsQ, orderByRaw: () => smsQ,
    limit: (n) => { limitN = n; return smsQ; },
    select: () => {
      let out = matchRows;
      if (after) {
        const t = Date.parse(after.sf);
        out = out.filter((r) => {
          const rt = new Date(r.scheduled_for).getTime();
          return rt > t || (rt === t && String(r.id) > String(after.id));
        });
      }
      if (limitN != null) out = out.slice(0, limitN);
      return Promise.resolve(out);
    },
    first: () => Promise.resolve(matchRows[0]),
  };
  return (table) => (table === 'customers' ? customersQ : smsQ);
}

// Owner ruling 2026-09-28: the bar cancels only STANDALONE scheduled
// messages, refused OUTRIGHT — never redirected to the Communications
// inbox, since that inbox's own cancel calls the SAME shared writer and
// would strand the same obligation (Codex round 2 on #5224, P1).
test('a workflow-owned sms_log row (entry_point with an onTerminal hook) is excluded from the list and refused outright, with no inbox pointer', async () => {
  const workflowOwnedEntryPoint = TERMINAL_HOOK_ENTRY_POINTS[0];
  expect(workflowOwnedEntryPoint).toBeTruthy(); // sanity: the registry actually has terminal-hook entries
  expect(requiresTerminalHook(workflowOwnedEntryPoint)).toBe(true);

  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: { entry_point: workflowOwnedEntryPoint },
  };

  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/managed by the/i);
  expect(out.error).toMatch(/workflow/i);
  expect(out.error).not.toMatch(/communications inbox/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

test('a registered deferred-replay row WITHOUT a terminal hook (invoice_send_deferred holds its invoice claim) is refused too, with no inbox pointer', async () => {
  expect(isDeferredReplayEntryPoint('invoice_send_deferred')).toBe(true);
  expect(requiresTerminalHook('invoice_send_deferred')).toBe(false);
  expect(isDeferredReplayEntryPoint('some_manual_send')).toBe(false);

  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'invoice', message_body: 'Synthetic invoice text',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: { entry_point: 'invoice_send_deferred' },
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/managed by the invoice send deferred workflow/i);
  expect(out.error).not.toMatch(/communications inbox/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// "Recruiting threads are answered from Recruiting only" — message_type is
// the general, always-present signal; a recruiting send may carry no
// entry_point at all, so this must be checked independently of the
// deferred-replay registry (pre-push audit P1, round 2 on #5224).
test('a recruiting-typed row (job_* message_type, no entry_point) is excluded from the list and refused outright, with no inbox pointer', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'job_application_received', message_body: 'Synthetic recruiting text',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/managed by the Recruiting workflow/i);
  expect(out.error).not.toMatch(/communications inbox/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// scheduler.js: finalize_only means the text itself already delivered — the
// row only exists for post-delivery bookkeeping, never "still queued."
test('a finalize_only sms_log row is excluded from the list and refused as already-delivered', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: { finalize_only: true },
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/already reached the provider/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// Codex round 3 on #5224, P1: scheduled-sms-delivery.js's dispatch() stamps
// review_ask_reservation BEFORE every review-ask provider call, and does
// NOT clear it when an ambiguous attempt is held back to 'scheduled' for
// its next ask-spacing retry (holdUncertainReservation) — only when
// delivery is later proven accepted or definitely not sent. So a
// 'scheduled' row can carry this marker with review_delivery_uncertain_
// exhausted STILL FALSE (that flag only appears on the FINAL such
// attempt) — Twilio may already have accepted an EARLIER attempt. Both
// states must refuse, not only the exhausted one.
test.each([
  ['review_ask_reservation alone (not yet exhausted — an earlier ambiguous attempt, held for retry)', { review_ask_reservation: true }],
  ['review_ask_reservation + review_delivery_uncertain_exhausted (the final ambiguous attempt)', { review_ask_reservation: true, review_delivery_uncertain_exhausted: true }],
])('a %s sms_log row is excluded from the list and refused as possibly-already-sent', async (_label, metaFlag) => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'review_request', message_body: 'Synthetic review ask',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: metaFlag,
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/may already have reached the provider/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// Codex round 2 on #5224, P2: a bounded body preview rides both the list
// output and the cancel preview, and is pinned into `_version` so a body
// edit between the card and Confirm refuses instead of silently cancelling
// the wrong-worded message.
test('a body preview (collapsed whitespace, capped ~160 chars) rides the list and the preview, masked recipient stays masked', async () => {
  const longBody = `Hi there,\n\n   this   is a synthetic reminder body that runs well past one hundred and sixty characters so the preview truncation logic actually has something real to cut off before it reaches the end of the message.`;
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: longBody,
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));

  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toHaveLength(1);
  const collapsed = longBody.replace(/\s+/g, ' ').trim();
  expect(listed.messages[0].body_preview).toBe(`${collapsed.slice(0, 160)}…`);
  expect(listed.messages[0].body_preview.length).toBe(161); // 160 chars + ellipsis
  expect(listed.messages[0].masked_recipient).toBe('…0100');
  expect(listed.messages[0].masked_recipient).not.toContain('9415550100');

  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(preview.body_preview).toBe(`${collapsed.slice(0, 160)}…`);
  expect(preview._version.body_preview).toBe(preview.body_preview);
  expect(preview.masked_recipient).toBe('…0100');
});

test('a body change between the preview and confirm refuses — the pinned body_preview no longer matches', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: 'Original synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(preview.body_preview).toBe('Original synthetic body');

  // The row's body changed since the card was shown (a reviewer edited the
  // draft) — the fresh re-read at commit time sees the new body.
  row.message_body = 'Edited synthetic body — different wording entirely';
  const confirmed = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(confirmed.success).not.toBe(true);
  expect(confirmed.preview_changed).toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// The SMS commit delegates entirely to the shared inbox workflow rather
// than writing sms_log itself — this proves the delegation (call shape +
// refusal on a non-cancelling result), not the workflow's own internals
// (thread lock, recruiting reconciliation, decision reopen — all covered
// against real Postgres, and by admin-communications-scheduled-cancel.test.js
// for the route side of that same shared function).
test('the SMS commit calls the shared cancel workflow with the pinned scheduled_for, and refuses when it reports no row cancelled', async () => {
  const scheduledFor = new Date('2099-01-01T12:00:00Z');
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic reminder body',
    scheduled_for: scheduledFor, metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));

  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(preview.proposal).toBe(true);

  // Confirm: the shared workflow reports the row was already claimed
  // (a race), never cancelled.
  cancelScheduledSmsRow.mockResolvedValue({ outcome: 'not_found', cancelled: false, row: null });
  const refused = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(cancelScheduledSmsRow).toHaveBeenCalledWith({
    id: MESSAGE_ID, techRole: 'admin', technicianId: null,
    expectedScheduledFor: scheduledFor.toISOString(), expectedToPhone: '+19415550100',
    expectedBodyDigest: require('crypto').createHash('md5').update('Synthetic reminder body', 'utf8').digest('hex'),
    expectedCustomerId: CUSTOMER_ID,
    simpleOnly: true,
  });
  expect(refused.success).not.toBe(true);
  expect(refused.preview_changed).toBe(true);

  // The shared workflow actually cancelled it — the tool reports success
  // using ITS OWN pinned display fields (masked recipient, kind), not
  // anything the shared workflow returns.
  cancelScheduledSmsRow.mockResolvedValue({ outcome: 'ok', cancelled: true, row: { id: MESSAGE_ID } });
  const success = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(success).toMatchObject({
    success: true, cancelled: true, channel: 'sms', message_id: MESSAGE_ID,
    masked_recipient: '…0100', kind: 'manual', messages_sent: false,
  });
});

// Codex round 3 on #5224, P2: customer-contact-fanout.js can rewrite a
// still-'scheduled' row's to_phone (a phone edit) without touching status
// or scheduled_for — the scheduled_for pin alone would not catch it.
test('the recipient (to_phone) is pinned into _version and threaded to the shared workflow as expectedToPhone', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(preview._version.to_phone).toBe('+19415550100');

  cancelScheduledSmsRow.mockResolvedValue({ outcome: 'ok', cancelled: true, row: { id: MESSAGE_ID } });
  await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(cancelScheduledSmsRow).toHaveBeenCalledWith(expect.objectContaining({ expectedToPhone: '+19415550100' }));
});

test('a recipient change between the preview and confirm refuses — the pinned to_phone no longer matches', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(preview.masked_recipient).toBe('…0100');

  // customer-contact-fanout.js retargets the row to a corrected number —
  // status and scheduled_for are untouched.
  row.to_phone = '+19415559999';
  const confirmed = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(confirmed.success).not.toBe(true);
  expect(confirmed.preview_changed).toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// Codex round 3 on #5224, P2: actionContext.technicianId (the confirming
// admin, threaded by the route into executeCommsTool) must reach
// cancelScheduledSmsRow instead of a hardcoded null, so agent_decisions.
// reviewed_by records the real admin if a parked decision reopens.
test('the confirming admin (actionContext.technicianId) is threaded into the shared cancel workflow', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });

  cancelScheduledSmsRow.mockResolvedValue({ outcome: 'ok', cancelled: true, row: { id: MESSAGE_ID } });
  await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  }, { technicianId: 'admin-synthetic-99' });
  expect(cancelScheduledSmsRow).toHaveBeenCalledWith(expect.objectContaining({ technicianId: 'admin-synthetic-99' }));
});

// Codex round 3 on #5224, P2: list_queued_messages is bounded like every
// other paged IB reader (query_customers, getScheduleView). Codex round 5
// P2: pages by a (scheduled_for, id) keyset cursor, not an offset.
test('list_queued_messages caps at the default limit (25) and pages by next_cursor', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: msgId(i), customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: `Synthetic body ${i}`,
    scheduled_for: new Date(Date.now() + (i + 1) * 60000), metadata: {},
  }));
  db.mockImplementation(makeSmsDbMock(rows));

  const page1 = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(page1.messages).toHaveLength(25);
  expect(page1.has_more).toBe(true);
  expect(page1.next_cursor).toEqual(expect.any(String));

  // The scheduler claims the first five rows between pages — an offset of
  // 25 would now skip five unseen rows; the cursor still resumes exactly
  // after the last row page one showed.
  rows.splice(0, 5);
  const page2 = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms', cursor: page1.next_cursor });
  expect(page2.messages.map((m) => m.message_id)).toEqual([25, 26, 27, 28, 29].map(msgId));
  expect(page2.has_more).toBe(false);
  expect(page2.next_cursor).toBeNull();
});

test('list_queued_messages keeps reading past ineligible rows so a page is not empty while more are queued', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: msgId(i), customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: `Synthetic body ${i}`,
    scheduled_for: new Date(Date.UTC(2099, 0, 1, 12, i)),
    // The first 26 were already attempted — never listed.
    metadata: i < 26 ? { provider_retry_at: '2099-01-01T11:00:00Z' } : {},
  }));
  db.mockImplementation(makeSmsDbMock(rows));
  const page = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(page.messages.map((m) => m.message_id)).toEqual([26, 27, 28, 29].map(msgId));
  expect(page.has_more).toBe(false);
  expect(page.next_cursor).toBeNull();
});

test('a scheduled text with no staff author (admin_user_id null) is refused even with empty metadata', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: null,
    to_phone: '+19415550100', message_type: 'reminder', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/automated workflow/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

test('list_queued_messages discloses texts it left out, so [] never reads as "nothing queued"', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'reminder', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: { entry_point: 'invoice_send_deferred' },
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const out = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.messages).toEqual([]);
  expect(out.has_more).toBe(false);
  expect(out.excluded_count).toBe(1);
  expect(out.note).toMatch(/still queued to send but can't be cancelled from the bar/i);
});

test('list_queued_messages refuses a cursor whose id is not a uuid (Postgres would reject the bound id)', async () => {
  db.mockImplementation(makeSmsDbMock([]));
  const cursor = Buffer.from('2099-01-01T12:00:00.000Z|not-a-uuid', 'utf8').toString('base64url');
  const out = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms', cursor });
  expect(out.error).toMatch(/cursor is not valid/i);
});

test('list_queued_messages refuses a malformed cursor instead of restarting from the top', async () => {
  db.mockImplementation(makeSmsDbMock([]));
  const out = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms', cursor: 'bm90LWEtY3Vyc29y' });
  expect(out.error).toMatch(/cursor is not valid/i);
});

// Codex round 5 on #5224, P1: scheduler.js requeues ANY retryable send
// failure to 'scheduled' with provider_retry_at — including an 'uncertain'
// Twilio handoff the provider may already have accepted.
test('a provider-retry row (provider_retry_at set) is excluded from the list and refused', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: { provider_retry_at: '2099-01-01T11:45:00Z', provider_retry_code: 'TWILIO_UNCERTAIN' },
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/may have reached the provider/i);
  expect(out.proposal).not.toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// Codex round 6 on #5224, P1 x2: the bar cancels only SIMPLE texts — never
// claimed by a send worker (stale-claim recovery, provider retry, refunded
// deferral) and not tied to Agent Review decisions (whose cancel reopens them
// or re-parks them onto a sibling reply).
test.each([
  ['recovered from a stale send claim', { scheduled_sms_recovered_at: '2099-01-01T11:50:00Z', scheduled_sms_claimed_at: '2099-01-01T11:40:00Z' }, /may have reached the provider/i],
  ['claimed once then deferred with the attempt refunded', { scheduled_sms_claimed_at: '2099-01-01T11:40:00Z', scheduled_sms_attempts: 0 }, /may have reached the provider/i],
  ['an AI-reply provider retry (twilio-webhook provider_retry: true)', { provider_retry: true }, /may have reached the provider/i],
  ['tied to an agent decision', { agent_decision_id: 'dec-synthetic-1' }, /Agent Review/i],
  ['queued by an automated producer (deposit-receipt requeue entry_point, no retry marker)', { entry_point: 'estimate_deposit_receipt_requeue', original_failure_code: 'TWILIO_TIMEOUT' }, /automated workflow|managed by/i],
  ['carrying parked decisions', { parked_decision_ids: ['dec-synthetic-2'] }, /Agent Review/i],
])('a row %s is excluded from the list and refused', async (_label, metadata, reason) => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: 'Synthetic body',
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata,
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(reason);
  expect(out.proposal).not.toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// Codex round 5 on #5224, P2: the 160-char preview alone misses an edit
// past the prefix — the full-body digest is pinned and threaded to the writer.
test('an edit past the 160-char preview refuses, and the full-body digest reaches the writer', async () => {
  const longBody = `${'a'.repeat(200)} original ending`;
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled', admin_user_id: STAFF_ID,
    to_phone: '+19415550100', message_type: 'manual', message_body: longBody,
    scheduled_for: new Date('2099-01-01T12:00:00Z'), metadata: {},
  };
  db.mockImplementation(makeSmsDbMock([row]));
  const preview = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  const expectedDigest = require('crypto').createHash('md5').update(longBody, 'utf8').digest('hex');
  expect(preview._version.body_digest).toBe(expectedDigest);

  row.message_body = `${'a'.repeat(200)} EDITED ending`;
  const refused = await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(refused.preview_changed).toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();

  row.message_body = longBody;
  cancelScheduledSmsRow.mockResolvedValue({ outcome: 'ok', cancelled: true, row: { id: MESSAGE_ID } });
  await executeCommsTool('cancel_queued_message', {
    message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms', confirmed: true,
    _verified_message_version: preview._version,
  });
  expect(cancelScheduledSmsRow).toHaveBeenCalledWith(expect.objectContaining({ expectedBodyDigest: expectedDigest }));
});

test('cancel_queued_message never sends anything and is not classified as customer contact', () => {
  const { CUSTOMER_CONTACT_TOOL_NAMES } = require('../services/intelligence-bar/authorization-contract');
  expect(CUSTOMER_CONTACT_TOOL_NAMES.has('cancel_queued_message')).toBe(false);
  const policy = require('../services/intelligence-bar/action-policy.json');
  expect(policy.cancel_queued_message).toMatchObject({ module: 'comms-tools.js', approval: 'ui_confirm', scope: 'record' });
  expect(policy.list_queued_messages).toMatchObject({ module: 'comms-tools.js', kind: 'read', scope: 'record' });
});

// Codex round 11 on #5224, P1: the confirmation card itself (not only the
// model) shows WHICH queued text the irreversible cancel hits.
test('the cancel card shows customer, masked recipient, send time and body preview — never just ids', () => {
  jest.isolateModules(() => {
    const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
    const shown = confirmationDisplayParams('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' }, {
      proposal: true, customer_id: CUSTOMER_ID, customer_name: 'Synthetic Fixture', masked_recipient: '…0100',
      kind: 'manual', scheduled_time: '2099-01-01T12:00:00.000Z', body_preview: 'Synthetic body',
    });
    expect(shown).toEqual({
      customer: 'Synthetic Fixture', recipient: '…0100', kind: 'manual',
      scheduled: '2099-01-01T12:00:00.000Z', message: 'Synthetic body',
    });
    expect(shown).not.toHaveProperty('message_id');
  });
});
