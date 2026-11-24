/**
 * send_estimate (owner ruling 2026-11-24): the Intelligence Bar sends ONE existing
 * unsent draft estimate through the estimate page's own Send handler, behind one
 * confirm card. The route's preview (estimateSendPreviewForBar) and send
 * (sendEstimateFromBar) are the only things that read the message or send; they
 * are tested in admin-estimates-reviewed-send.test.js and friends, and here they
 * are canned. This suite checks the allow-list, the card, the pins and that
 * Confirm calls the shared handler exactly once with the pinned body.
 * Synthetic names only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const tables = {};
const reads = [];
const writes = [];

jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const m of ['whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'whereIn', 'orderBy', 'limit', 'whereRaw', 'leftJoin']) q[m] = () => q;
    q.where = (cond) => { q.cond = cond; return q; };
    q.first = () => { reads.push(table); return Promise.resolve((tables[table] || [])[0]); };
    q.select = () => q;
    q.then = (resolve, reject) => Promise.resolve(tables[table] || []).then(resolve, reject);
    for (const m of ['insert', 'update', 'del', 'delete']) q[m] = (...args) => { writes.push({ table, op: m, args }); return q; };
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.schema = { hasTable: async () => true };
  db.raw = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-estimates', () => ({ sendEstimateFromBar: jest.fn(), estimateSendPreviewForBar: jest.fn() }));

const { sendEstimateFromBar, estimateSendPreviewForBar } = require('../routes/admin-estimates');
const { executeEstimateSendTool, ESTIMATE_SEND_TOOLS } = require('../services/intelligence-bar/estimate-send-tools');
const AuthorizationContract = require('../services/intelligence-bar/authorization-contract');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const ActionRegistry = require('../services/intelligence-bar/action-registry');

const ESTIMATE_ID = '00000000-0000-0000-0000-0000000e5001';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000e5002';
const OTHER_CUSTOMER_ID = '00000000-0000-0000-0000-0000000e5003';
const INPUT = { estimate_id: ESTIMATE_ID };
const SMS = 'Hi Lena, your Waves estimate is ready: https://portal.wavespestcontrol.com/estimate/draftquote42';
const EMAIL = { provider: 'sendgrid', subject: 'Your Waves Pest Control estimate', text: 'Hi Lena, your estimate is ready to review at the link below.' };

function seed(estimate = {}) {
  tables.estimates = [{
    id: ESTIMATE_ID, token: 'draftquote42', status: 'draft', customer_id: CUSTOMER_ID, customer_name: 'Lena Q Synthetic',
    monthly_total: 49, annual_total: 588, onetime_total: 99, waveguard_tier: 'Bronze', estimate_group_id: null,
    sent_at: null, scheduled_at: null, archived_at: null, price_locked_at: null, estimate_data: {}, ...estimate,
  }];
}

// What the route's own preview answers for the draft above.
function routePreview(overrides = {}) {
  return {
    status: 200,
    json: {
      id: ESTIMATE_ID, status: 'draft', editVersion: 'edit-v1', messageVersion: 'msg-v1',
      customerName: 'Lena Q Synthetic', customerPhone: '+19415550142', customerEmail: 'lena.synthetic@example.com',
      address: '12 Example Lane, Bradenton, FL', smsBlockReason: null, uncertainAttempt: false,
      messages: { sms: SMS, email: EMAIL }, ...overrides,
    },
  };
}

const sendReply = (json, status = 200) => ({ status, json });

beforeEach(() => {
  process.env.GATE_IB_SEND_ESTIMATE = 'true';
  reads.length = 0;
  writes.length = 0;
  seed();
  estimateSendPreviewForBar.mockReset();
  estimateSendPreviewForBar.mockImplementation(async () => routePreview());
  sendEstimateFromBar.mockReset();
  sendEstimateFromBar.mockImplementation(async () => sendReply({ success: true, sent: true, channels: { sms: { ok: true, real: true }, email: { ok: true, providerAccepted: true } } }));
});
afterAll(() => { delete process.env.GATE_IB_SEND_ESTIMATE; });

const run = (input = INPUT, ctx = {}) => executeEstimateSendTool('send_estimate', input, { isAdmin: true, ...ctx });
const card = (preview) => AuthorizationContract.buildContract({ toolName: 'send_estimate', params: INPUT, displayParams: {}, preview });
const labels = (contract) => [...contract.effects, ...(contract.more_effects || [])].map((e) => e.label);

describe('gate and role', () => {
  test('with the gate off nothing is offered and a forced call refuses before any read', async () => {
    delete process.env.GATE_IB_SEND_ESTIMATE;
    const result = await run();
    expect(result.code).toBe('send_estimate_not_enabled');
    expect(reads).toEqual([]);
    expect(estimateSendPreviewForBar).not.toHaveBeenCalled();
    expect(ActionRegistry.allowed(ActionRegistry.actions.get('send_estimate'), { role: 'admin', context: 'customers' })).toBe(false);
  });

  test('a non-admin call, and an unflagged confirmed run, are refused', async () => {
    expect((await run(INPUT, { isAdmin: false })).code).toBe('permission_denied');
    expect((await executeEstimateSendTool('send_estimate', { ...INPUT, confirmed: true }, {})).code).toBe('permission_denied');
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });
});

describe('refusals before any card', () => {
  test.each([
    ['sent', 'estimate_already_sent', /already sent/],
    ['viewed', 'estimate_already_sent', /already sent/],
    ['accepted', 'estimate_accepted', /already accepted/],
    ['declined', 'estimate_declined', /declined/],
    ['expired', 'estimate_expired', /expired/],
    ['scheduled', 'estimate_scheduled', /scheduled to send/],
    ['sending', 'estimate_sending', /being sent right now/],
    ['send_failed', 'estimate_send_failed', /earlier send/],
  ])('a %s estimate is refused with a plain reason', async (status, code, words) => {
    seed({ status });
    const result = await run();
    expect(result.code).toBe(code);
    expect(result.error).toMatch(words);
    expect(estimateSendPreviewForBar).not.toHaveBeenCalled();
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['a draft that was already sent once', { sent_at: '2026-11-01T12:00:00Z' }, 'estimate_already_sent'],
    ['a draft with a send time set', { scheduled_at: '2026-12-01T12:00:00Z' }, 'estimate_scheduled'],
    ['an archived draft', { archived_at: '2026-11-01T12:00:00Z' }, 'estimate_archived'],
    ['a price-locked draft', { price_locked_at: '2026-11-01T12:00:00Z' }, 'estimate_price_locked'],
    ['a grouped estimate', { estimate_group_id: '00000000-0000-0000-0000-0000000e50ff' }, 'grouped_estimate'],
    ['a commercial proposal', { estimate_data: { proposal: { enabled: true } } }, 'commercial_proposal'],
  ])('%s is refused', async (_name, patch, code) => {
    seed(patch);
    const result = await run();
    expect(result.code).toBe(code);
    expect(result.error).toMatch(/Nothing was sent\.$/);
    expect(estimateSendPreviewForBar).not.toHaveBeenCalled();
  });

  test('an estimate that belongs to another customer, or to none, is refused when a customer is named', async () => {
    expect((await run({ ...INPUT, customer_id: OTHER_CUSTOMER_ID })).code).toBe('estimate_customer_mismatch');
    seed({ customer_id: null });
    expect((await run({ ...INPUT, customer_id: CUSTOMER_ID })).code).toBe('estimate_customer_mismatch');
    // An unlinked draft (a new lead) is sendable when no customer is named.
    expect((await run()).preview).toBe(true);
  });

  test('a later send, a bad id and a bad channel are refused', async () => {
    for (const key of ['scheduledAt', 'scheduled_at', 'send_at']) {
      expect((await run({ ...INPUT, [key]: '2026-12-01T09:00:00-05:00' })).code).toBe('scheduled_send_unsupported');
    }
    expect((await run({ estimate_id: 'not-a-uuid' })).code).toBe('invalid_target');
    expect((await run({ ...INPUT, send_method: 'carrier_pigeon' })).code).toBe('invalid_send_method');
    expect(estimateSendPreviewForBar).not.toHaveBeenCalled();
  });

  test('an unknown estimate is refused', async () => {
    tables.estimates = [];
    expect((await run()).code).toBe('estimate_not_found');
  });

  test('what the estimate page itself blocks reaches the operator in the page\'s own words', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ blockReason: 'County records could not confirm this house number. Correct the address first.', requiresEngineReview: false }));
    const result = await run();
    expect(result.code).toBe('page_refuses');
    expect(result.error).toBe('County records could not confirm this house number. Correct the address first.');
  });

  test('an AI draft flagged for engine review is refused, never acknowledged for the operator', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ blockReason: 'This AI draft is flagged for review (fallback sqft). Open AI Draft Review on the estimate, then confirm the send.', requiresEngineReview: true }));
    const result = await run();
    expect(result.error).toMatch(/flagged for review/);
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test('an earlier uncertain send and a needed palm count are refused', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ uncertainAttempt: true }));
    expect((await run()).code).toBe('send_outcome_uncertain');
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ satellitePalmCount: 7 }));
    expect((await run()).code).toBe('palm_count_required');
  });

  test('a route preview that is not the same unsent draft, or cannot be read, is refused', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ status: 'sent' }));
    expect((await run()).preview_changed).toBe(true);
    estimateSendPreviewForBar.mockImplementation(async () => ({ status: 404, json: { error: 'Estimate not found' } }));
    expect((await run()).error).toBe('Estimate not found');
  });

  test('a channel with no phone, email or message is refused, and no channel at all is refused', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ customerPhone: null }));
    const noText = await run({ ...INPUT, send_method: 'sms' });
    expect(noText.code).toBe('channel_unavailable');
    expect(noText.error).toMatch(/no phone number/);
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ smsBlockReason: 'That phone number cannot receive texts.' }));
    expect((await run({ ...INPUT, send_method: 'both' })).error).toMatch(/cannot receive texts/);
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ customerPhone: null, customerEmail: null }));
    expect((await run()).code).toBe('no_channel');
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ messages: { sms: SMS, email: null } }));
    expect((await run({ ...INPUT, send_method: 'email' })).error).toMatch(/email template is unavailable/);
  });
});

describe('the card', () => {
  test('names the estimate, the customer as first name and last initial, the masked recipients, the channel, the exact messages and the totals', async () => {
    const preview = await run();
    expect(preview).toMatchObject({
      preview: true, tool: 'send_estimate', estimate_id: ESTIMATE_ID, customer_name: 'Lena S.', send_method: 'both', channels: ['text', 'email'],
      recipients: { text: '***0142', email: 'l***@example.com' },
    });
    const lines = labels(card(preview));
    expect(lines).toContain('Sends estimate draftquo to Lena S. (Bronze)');
    expect(lines).toContain('Service address: 12 Example Lane, Bradenton, FL');
    expect(lines).toContain('Totals: $49.00 a month, $588.00 a year, $99.00 one-time');
    expect(lines).toContain(`Text to ***0142: ${SMS}`);
    expect(lines).toContain(`Email to l***@example.com, subject: ${EMAIL.subject}`);
    expect(lines).toContain(`Email text: ${EMAIL.text}`);
    expect(lines.join('\n')).not.toMatch(/9415550142|lena\.synthetic/);
    expect(JSON.stringify(preview)).not.toMatch(/9415550142|lena\.synthetic|Synthetic/);
  });

  test('is irreversible, contacts the customer and sends nothing by itself', async () => {
    const contract = card(await run());
    expect(contract.irreversible).toBe(true);
    expect(contract.notifies_customer).toBe(true);
    expect(contract.action_label).toBe('Send a draft estimate to the customer');
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('the default channel is every channel the customer has; a lone one is used; an explicit one wins', async () => {
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ customerEmail: null }));
    expect((await run()).send_method).toBe('sms');
    estimateSendPreviewForBar.mockImplementation(async () => routePreview({ customerPhone: null }));
    expect((await run()).send_method).toBe('email');
    estimateSendPreviewForBar.mockImplementation(async () => routePreview());
    const emailOnly = await run({ ...INPUT, send_method: 'email' });
    expect(emailOnly).toMatchObject({ send_method: 'email', channels: ['email'], recipients: { text: null, email: 'l***@example.com' }, sms_text: null });
    expect(labels(card(emailOnly)).join('\n')).not.toMatch(/^Text to/m);
  });

  test('pins the edit version, the message version and the channel, and never a raw address', async () => {
    const preview = await run();
    expect(preview._version).toEqual({ estimate_id: ESTIMATE_ID, edit_version: 'edit-v1', message_version: 'msg-v1', send_method: 'both' });
  });

  test('the proposal call never sends', async () => {
    await run();
    await run({ ...INPUT, send_method: 'sms' });
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe('Confirm', () => {
  const confirmWith = async (pinned, ctx = {}, input = {}) => run({ ...INPUT, ...input, confirmed: true, _verified_estimate_send_version: pinned }, { operationId: 'op-7f3a', technicianId: 'tech-owner', ...ctx });

  test('calls the shared send handler once with the pinned review body and a fresh attempt id', async () => {
    const { _version } = await run();
    const result = await confirmWith(_version);
    expect(sendEstimateFromBar).toHaveBeenCalledTimes(1);
    expect(sendEstimateFromBar).toHaveBeenCalledWith({
      estimateId: ESTIMATE_ID,
      body: { sendMethod: 'both', expectedEditVersion: 'edit-v1', messageVersion: 'msg-v1', idempotencyKey: 'bar-op-7f3a' },
    });
    const body = sendEstimateFromBar.mock.calls[0][0].body;
    // None of the operator-only decisions rides along.
    for (const key of ['scheduledAt', 'acknowledgeEngineReview', 'acknowledgeUncertainSend', 'confirmedPalmCount', 'groupVersions']) expect(body).not.toHaveProperty(key);
    expect(result).toMatchObject({ success: true, estimate_id: ESTIMATE_ID });
    expect(result.message).toBe("Lena S.'s estimate draftquo was sent by text and email.");
  });

  test('a card for one channel confirms that channel only', async () => {
    const { _version } = await run({ ...INPUT, send_method: 'sms' });
    await confirmWith(_version, {}, { send_method: 'sms' });
    expect(sendEstimateFromBar.mock.calls[0][0].body.sendMethod).toBe('sms');
    // The channel is part of the card: a confirm that no longer resolves to it is stale.
    sendEstimateFromBar.mockClear();
    expect((await confirmWith(_version, {}, { send_method: 'email' })).preview_changed).toBe(true);
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test('refuses without a verified card or without an operation id, sending nothing', async () => {
    expect((await run({ ...INPUT, confirmed: true }, { operationId: 'op-1' })).code).toBe('approval_required');
    const { _version } = await run();
    expect((await run({ ...INPUT, confirmed: true, _verified_estimate_send_version: _version })).code).toBe('approval_required');
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['the saved estimate changed', { editVersion: 'edit-v2' }],
    ['the message changed', { messageVersion: 'msg-v2' }],
    ['the recipient lost the email, which changes the channel the card named', { customerEmail: null }],
  ])('refuses as stale when %s after the card was shown', async (_name, change) => {
    const { _version } = await run();
    estimateSendPreviewForBar.mockImplementation(async () => routePreview(change));
    const result = await confirmWith(_version);
    expect(result.preview_changed).toBe(true);
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test('refuses as stale when the draft was sent or scheduled after the card', async () => {
    const { _version } = await run();
    seed({ status: 'sent' });
    const result = await confirmWith(_version);
    expect(result.preview_changed).toBe(true);
    expect(result.error).toMatch(/already sent/);
    expect(sendEstimateFromBar).not.toHaveBeenCalled();
  });

  test('a stale review caught by the route is relayed in its own words as preview_changed', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply({ error: 'The delivery message changed. Close this dialog and review it again.', code: 'ESTIMATE_REVIEW_STALE' }, 409));
    const result = await confirmWith(_version);
    expect(result).toMatchObject({ failed: true, preview_changed: true, code: 'ESTIMATE_REVIEW_STALE', error: 'The delivery message changed. Close this dialog and review it again.' });
    expect(sendEstimateFromBar).toHaveBeenCalledTimes(1);
  });

  test.each([
    [400, { error: 'This estimate has no customer link token, so there is nothing to send.' }],
    [409, { error: 'This estimate is being sent or is locked right now. Wait a moment and retry.' }],
    [409, { error: 'Pricing authority: the stored price was not produced by the server.', code: 'PRICING_AUTHORITY_REQUIRED' }],
  ])('a route refusal (%s) is returned verbatim and nothing is retried', async (status, json) => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply(json, status));
    const result = await confirmWith(_version);
    expect(result).toMatchObject({ failed: true, nothing_sent: true, error: json.error });
    expect(result).not.toHaveProperty('preview_changed');
    expect(sendEstimateFromBar).toHaveBeenCalledTimes(1);
  });

  test('an uncertain earlier send is never retried and says so', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply({ error: 'The earlier send may have reached a provider.', code: 'SEND_OUTCOME_UNCERTAIN' }, 409));
    const result = await confirmWith(_version);
    expect(result).toMatchObject({ outcome_unknown: true, code: 'SEND_OUTCOME_UNCERTAIN' });
    expect(result.error).toMatch(/Do not send it again/);
  });

  test('a provider outcome that cannot be confirmed is outcome_unknown, not a failure to retry', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply({ success: false, error: 'Estimate was not sent on any requested channel', channels: { email: { ok: false, uncertain: true } } }, 422));
    const result = await confirmWith(_version);
    expect(result.outcome_unknown).toBe(true);
    expect(result.error).toMatch(/may or may not have gone out/);
  });

  test('one channel sent and one not is a success with a warning that names both', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply({ success: true, sent: true, channels: { sms: { ok: true, real: true }, email: { ok: false, error: 'Mailbox rejected' } } }));
    const result = await confirmWith(_version);
    expect(result.success).toBe(true);
    expect(result.warning).toBe('The estimate went out by text, but not by email.');
  });

  test('a suppressed text (ok, not real) is not reported as sent', async () => {
    const { _version } = await run({ ...INPUT, send_method: 'sms' });
    sendEstimateFromBar.mockImplementation(async () => sendReply({ success: true, sent: true, channels: { sms: { ok: true, real: false } } }));
    const result = await confirmWith(_version, {}, { send_method: 'sms' });
    expect(result).toMatchObject({ failed: true, code: 'no_message_handed_off', channels: [{ channel: 'text', status: 'not_sent' }] });
    expect(result).not.toHaveProperty('success');
  });

  test('a replayed attempt is said to be a replay and sends nothing new', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => sendReply({ success: true, sent: true, replayed: true, channels: { sms: { ok: true, real: true }, email: { ok: true, providerAccepted: true } } }));
    const result = await confirmWith(_version);
    expect(result.replayed).toBe(true);
    expect(result.message).toMatch(/already sent from this card/);
  });

  test('a throw during the send never invites a retry', async () => {
    const { _version } = await run();
    sendEstimateFromBar.mockImplementation(async () => { throw new Error('socket hang up'); });
    expect(await confirmWith(_version)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});

describe('registration', () => {
  test('is a two-step, admin-only, carded write that loads on the estimates, customers and dashboard pages only while the gate is on', () => {
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('send_estimate')).toBe(true);
    expect(ESTIMATE_SEND_TOOLS[0].input_schema.properties).not.toHaveProperty('confirmed');
    expect(ESTIMATE_SEND_TOOLS[0].input_schema.required).toEqual(['estimate_id']);
    expect(ActionRegistry.actions.get('send_estimate')).toMatchObject({ role: 'admin', approval: 'ui_confirm' });
    for (const context of ['estimates', 'customers', 'dashboard']) {
      expect(ActionRegistry.initialTools(context, { role: 'admin' }).map((t) => t.name)).toContain('send_estimate');
    }
    expect(ActionRegistry.initialTools('seo', { role: 'admin' }).map((t) => t.name)).not.toContain('send_estimate');
    delete process.env.GATE_IB_SEND_ESTIMATE;
    expect(ActionRegistry.initialTools('customers', { role: 'admin' }).map((t) => t.name)).not.toContain('send_estimate');
  });

  test('is never an owner-direct edit', () => {
    const OwnerDirect = require('../services/intelligence-bar/owner-direct');
    expect([...OwnerDirect.OWNER_DIRECT_TOOL_NAMES]).not.toContain('send_estimate');
  });
});
