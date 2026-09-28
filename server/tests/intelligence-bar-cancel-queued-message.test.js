// cancel_queued_message / list_queued_messages — fast, no-DB unit coverage.
// Real end-to-end CAS behavior (list only queued, cancel exactly one,
// refuse a sent/sending message, refuse a changed token/scheduled time,
// the shared SMS cancel workflow's own reconciliation) is covered against
// real PostgreSQL in intelligence-bar-cancel-queued-message-postgres.test.js,
// which skips cleanly without DATABASE_URL.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  cancelQueuedMessage: jest.fn(),
  PROVIDER_HANDOFF_STARTED: 'started',
}));
jest.mock('../services/scheduled-sms-cancel', () => ({ cancelScheduledSmsRow: jest.fn() }));

const db = require('../models/db');
const { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { cancelQueuedMessage: cancelQueuedEmailMessage } = require('../services/email-template-library');
const { cancelScheduledSmsRow } = require('../services/scheduled-sms-cancel');
const { requiresTerminalHook } = require('../services/messaging/deferred-replay-registry');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
});

test('registration: cancel_queued_message is a two-step write, list_queued_messages is a read-only tool', () => {
  expect(WRITE_TWO_STEP_TOOL_NAMES.has('cancel_queued_message')).toBe(true);
  const cancelTool = COMMS_TOOLS.find((t) => t.name === 'cancel_queued_message');
  expect(cancelTool).toBeDefined();
  expect(cancelTool._sideEffects).not.toBe(true); // preview-only until confirmed, like the other two-step tools
  expect(Object.keys(cancelTool.input_schema.properties)).not.toContain('confirmed');
  expect(cancelTool.input_schema.properties.message_id.format).toBe('uuid');
  expect(cancelTool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(cancelTool.input_schema.required).toEqual(['message_id', 'customer_id', 'channel']);

  const listTool = COMMS_TOOLS.find((t) => t.name === 'list_queued_messages');
  expect(listTool).toBeDefined();
  expect(listTool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(COMMS_READ_TOOLS.map((t) => t.name)).toContain('list_queued_messages');
  expect(COMMS_READ_TOOLS.map((t) => t.name)).not.toContain('cancel_queued_message');
});

test('rejects a malformed message_id/customer_id/channel before touching the database', async () => {
  const badId = await executeCommsTool('cancel_queued_message', { message_id: 'not-a-uuid', customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(badId.error).toMatch(/resolve/i);

  const badChannel = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'fax' });
  expect(badChannel.error).toMatch(/channel/i);

  expect(db).not.toHaveBeenCalled();
});

test('a preview read failure refuses — it never falls through as "nothing queued"', async () => {
  db.mockImplementation(() => { throw new Error('connection reset by peer'); });
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toBeTruthy();
  expect(out.success).not.toBe(true);
  expect(out.proposal).not.toBe(true);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
  expect(cancelQueuedEmailMessage).not.toHaveBeenCalled();
});

test('an unconfirmed call never reaches either store\'s cancel function', async () => {
  // Row not found is enough to prove the preview path never commits —
  // real "found and eligible" preview behavior is proven end to end
  // against Postgres.
  const builder = { where: () => builder, first: () => Promise.resolve(undefined) };
  db.mockImplementation(() => builder);
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/could not be found/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
  expect(cancelQueuedEmailMessage).not.toHaveBeenCalled();
});

test('confirmed:true with no pinned _verified_message_version refuses instead of committing', async () => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled',
    to_phone: '+19415550100', message_type: 'manual', scheduled_for: new Date('2099-01-01T12:00:00Z'),
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
    id: MESSAGE_ID, customer_id: otherCustomer, direction: 'outbound', status: 'scheduled',
    to_phone: '+19415550100', message_type: 'manual', scheduled_for: new Date('2099-01-01T12:00:00Z'),
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

// Owner ruling 2026-09-28: the bar cancels only STANDALONE scheduled
// messages. A row whose entry_point owns an onTerminal hook in the
// deferred-replay registry is workflow-owned and must never be listed or
// previewed as cancelable through this tool.
test('a workflow-owned sms_log row (entry_point with an onTerminal hook) is excluded from the list and refused in the preview', async () => {
  const { TERMINAL_HOOK_ENTRY_POINTS } = require('../services/messaging/deferred-replay-registry');
  const workflowOwnedEntryPoint = TERMINAL_HOOK_ENTRY_POINTS[0];
  expect(workflowOwnedEntryPoint).toBeTruthy(); // sanity: the registry actually has terminal-hook entries
  expect(requiresTerminalHook(workflowOwnedEntryPoint)).toBe(true);

  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled',
    to_phone: '+19415550100', message_type: 'reminder', scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: { entry_point: workflowOwnedEntryPoint },
  };

  // list_queued_messages excludes it entirely.
  const listBuilder = {
    where: () => listBuilder, orderBy: () => listBuilder, select: () => Promise.resolve([row]),
    first: () => Promise.resolve({ id: CUSTOMER_ID, first_name: 'Synthetic', last_name: 'Fixture' }),
  };
  db.mockImplementation((table) => (table === 'email_messages' ? { ...listBuilder, select: () => Promise.resolve([]) } : listBuilder));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  // cancel_queued_message's preview refuses it by name, pointing at the inbox.
  const previewBuilder = { where: () => previewBuilder, first: () => Promise.resolve(row) };
  db.mockImplementation((table) => (table === 'customers' ? { where: () => ({ first: () => Promise.resolve({ first_name: 'Synthetic', last_name: 'Fixture' }) }) } : previewBuilder));
  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/workflow/i);
  expect(out.error).toMatch(/communications inbox/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// scheduler.js/scheduled-sms-delivery.js: finalize_only and
// review_delivery_uncertain_exhausted both mean the text already reached
// the provider — the row only exists for post-delivery bookkeeping or a
// terminal-hook safety hold, never "still queued."
const CUSTOMER_ROW = { id: CUSTOMER_ID, first_name: 'Synthetic', last_name: 'Fixture' };

// A db mock covering all three tables list_queued_messages/cancel_queued_message
// ever touch: `customers` (resolveCustomer/customerDisplayName) answers via
// `.first()`; the row's OWN table answers `.select()` (list) or `.first()`
// (preview) with `matchRows`; the OTHER message table answers empty.
function makeMessageDbMock(matchTable, matchRows) {
  const customersQ = { where: () => customersQ, first: () => Promise.resolve(CUSTOMER_ROW) };
  const matchQ = {
    where: () => matchQ, orderBy: () => matchQ,
    select: () => Promise.resolve(matchRows), first: () => Promise.resolve(matchRows[0]),
  };
  const emptyQ = { where: () => emptyQ, orderBy: () => emptyQ, select: () => Promise.resolve([]), first: () => Promise.resolve(undefined) };
  return (table) => (table === 'customers' ? customersQ : table === matchTable ? matchQ : emptyQ);
}

test.each([
  ['finalize_only', { finalize_only: true }],
  ['review_delivery_uncertain_exhausted', { review_delivery_uncertain_exhausted: true }],
])('a %s sms_log row is excluded from the list and refused as already-delivered', async (_label, metaFlag) => {
  const row = {
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled',
    to_phone: '+19415550100', message_type: 'reminder', scheduled_for: new Date('2099-01-01T12:00:00Z'),
    metadata: metaFlag,
  };
  db.mockImplementation(makeMessageDbMock('sms_log', [row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'sms' });
  expect(out.error).toMatch(/already reached the provider/i);
  expect(cancelScheduledSmsRow).not.toHaveBeenCalled();
});

// An 'email_messages' row mid-provider-handoff (status still 'queued', but
// provider_handoff_phase already flipped to 'started' immediately before
// the real SendGrid call) must be refused, not treated as cancelable.
test('a currently-sending email (provider_handoff_phase started) is excluded from the list and refused in the preview', async () => {
  const row = {
    id: MESSAGE_ID, status: 'queued', recipient_type: 'customer', recipient_id: CUSTOMER_ID,
    recipient_email_snapshot: 'synthetic.fixture@example.com', template_key: 'synthetic.test',
    queued_at: new Date(), provider_handoff_phase: 'started', send_attempt_token: 'tok-1',
  };
  db.mockImplementation(makeMessageDbMock('email_messages', [row]));
  const listed = await executeCommsTool('list_queued_messages', { customer_id: CUSTOMER_ID, channel: 'email' });
  expect(listed.messages).toEqual([]);

  const out = await executeCommsTool('cancel_queued_message', { message_id: MESSAGE_ID, customer_id: CUSTOMER_ID, channel: 'email' });
  expect(out.error).toMatch(/currently being sent/i);
  expect(cancelQueuedEmailMessage).not.toHaveBeenCalled();
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
    id: MESSAGE_ID, customer_id: CUSTOMER_ID, direction: 'outbound', status: 'scheduled',
    to_phone: '+19415550100', message_type: 'manual', scheduled_for: scheduledFor,
  };
  const builder = { where: () => builder, first: () => Promise.resolve(row) };
  db.mockImplementation((table) => (table === 'customers' ? { where: () => ({ first: () => Promise.resolve({ first_name: 'Synthetic', last_name: 'Fixture' }) }) } : builder));

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
    expectedScheduledFor: scheduledFor.toISOString(),
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

test('cancel_queued_message never sends anything and is not classified as customer contact', () => {
  const { CUSTOMER_CONTACT_TOOL_NAMES } = require('../services/intelligence-bar/authorization-contract');
  expect(CUSTOMER_CONTACT_TOOL_NAMES.has('cancel_queued_message')).toBe(false);
  const policy = require('../services/intelligence-bar/action-policy.json');
  expect(policy.cancel_queued_message).toMatchObject({ module: 'comms-tools.js', approval: 'ui_confirm', scope: 'record' });
  expect(policy.list_queued_messages).toMatchObject({ module: 'comms-tools.js', kind: 'read', scope: 'record' });
});
