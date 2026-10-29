/**
 * IB compose_email (IB gap #9): the Email page's Compose + Send for a NEW email, run in process behind a card, dark behind
 * GATE_IB_COMPOSE_EMAIL (needs GATE_IB_PLATFORM). What the card shows (To with name and address, From, subject, the exact
 * body, every effect), what it refuses (bad or several addresses, no email on file, empty or over-long text, a portal link
 * in the body), pin drift, gate off, admin only, always a card (the owner's login too), that the confirmed run sends
 * exactly the carded fields once through the shared sendEmailMessage, and the outcomes (accepted, unknown, not accepted).
 * The provider is mocked: no email is ever sent. The double-Confirm race against real Postgres is
 * intelligence-bar-compose-email-postgres.test.js. Synthetic names and addresses only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockSendMessage = jest.fn();
jest.mock('../services/email/gmail-client', () => ({
  sendMessage: (...a) => mockSendMessage(...a),
  fromHeader: () => 'Waves Pest Control <office@example.invalid>',
}));
const mockLinkRefusal = jest.fn();
jest.mock('../services/intelligence-bar/email-tools', () => {
  const actual = jest.requireActual('../services/intelligence-bar/email-tools');
  return { ...actual, sendEmailReplyProposalRefusal: (...a) => mockLinkRefusal(...a) };
});

const db = require('../models/db');
const { executeComposeEmailTool, COMPOSE_EMAIL_TOOLS, cardLines } = require('../services/intelligence-bar/compose-email-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { OWNER_DIRECT_TOOL_NAMES, executesWithoutCard, mayExecuteWithoutCard } = require('../services/intelligence-bar/owner-direct');
const { encodeEmailBody } = require('../services/email/send-message');

const CUST = '00000000-0000-4000-8000-0000000000c1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };
const OWNER = { isAdmin: true, fullAccess: true, technicianId: 'owner-1' };
const SUBJECT = 'Your visit tomorrow';
const BODY = 'Hi Robin,\nWe will be there tomorrow between 9 and 11. R&D note: price <100.\nThanks, Waves';

let S;
const freshState = () => ({
  customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null, email: 'Robin.Sample@Example.invalid', deleted_at: null }],
});

function makeTable() {
  const q = { filters: [], emailEq: null, single: false };
  const run = () => {
    const rows = S.customers.filter((r) => q.filters.every(([k, v]) => r[k] === v) && r.deleted_at == null
      && (q.emailEq === null || String(r.email || '').toLowerCase() === q.emailEq));
    return q.single ? rows[0] : rows;
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve().then(run).then(res, rej);
      if (prop === 'first') return () => { q.single = true; return b; };
      if (prop === 'where') return (k) => { Object.entries(k).forEach((e) => q.filters.push(e)); return b; };
      if (prop === 'whereRaw') return (_sql, [v]) => { q.emailEq = v; return b; };
      if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)}`);
      return () => b;
    },
  });
  return b;
}

function envGate(on) {
  if (on) { process.env.GATE_IB_COMPOSE_EMAIL = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_COMPOSE_EMAIL; delete process.env.GATE_IB_PLATFORM; }
}

let op = 0;
const preview = (input = {}, ctx = ADMIN) => executeComposeEmailTool('compose_email', { customer_id: CUST, subject: SUBJECT, body: BODY, ...input }, ctx);
const confirm = (card, input = {}, ctx = { ...ADMIN, operationId: `op-${++op}` }) => executeComposeEmailTool('compose_email',
  { customer_id: CUST, subject: SUBJECT, body: BODY, ...input, confirmed: true, _verified_compose_email_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  S = freshState();
  db.mockImplementation(() => makeTable());
  envGate(true);
  mockLinkRefusal.mockResolvedValue(null);
  mockSendMessage.mockResolvedValue({ id: 'gmail-msg-1' });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step external action, admin only, in the email domain, never owner-direct', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('compose_email')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('compose_email')).toBe(true);
    expect(registry.actions.get('compose_email')).toMatchObject({ domain: 'email', kind: 'external_action', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'compose-email-tools.js' });
    expect(registry.actions.get('compose_email').domain).toBe(registry.actions.get('send_email_reply').domain);
    expect(registry.policyErrors).not.toContain('compose_email');
    expect(COMPOSE_EMAIL_TOOLS[0]._sideEffects).toBe(true);
    // An allowlist: a tool not listed always keeps its card, the owner's login included.
    expect(OWNER_DIRECT_TOOL_NAMES.has('compose_email')).toBe(false);
    const input = { customer_id: CUST, subject: SUBJECT, body: BODY };
    expect(executesWithoutCard('compose_email', input, { preview: true })).toBe(false);
    expect(mayExecuteWithoutCard('compose_email', input)).toBe(false);
  });

  test('offered wherever send_email_reply is offered while on; gone with either gate off; never for a technician', () => {
    const offered = (context) => registry.initialTools(context, { role: 'admin', fullAccess: false }).map((d) => d.name);
    for (const context of ['email', 'comms', 'dashboard', 'customers', 'schedule']) {
      expect(offered(context).includes('compose_email')).toBe(offered(context).includes('send_email_reply'));
    }
    expect(offered('email')).toEqual(expect.arrayContaining(['send_email_reply', 'compose_email']));
    delete process.env.GATE_IB_COMPOSE_EMAIL;
    expect(offered('email')).not.toContain('compose_email');
    envGate(true);
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('compose_email'), { role: 'admin', context: 'email' })).toBe(false);
    envGate(true);
    expect(registry.allowed(registry.actions.get('compose_email'), { role: 'technician', context: 'tech' })).toBe(false);
  });

  test('discoverable by the operator\'s words', () => {
    for (const query of ['compose a new email', 'send an email to a customer']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'dashboard', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('compose_email');
    }
  });
});

describe('gate, login and the card', () => {
  test('gate off: every call refuses and nothing is sent', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeComposeEmailTool('compose_email', { customer_id: CUST, subject: SUBJECT, body: BODY, confirmed: true, _verified_compose_email_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, {})).toMatchObject({ code: 'permission_denied' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('the owner login gets a card too: the first call only previews, and a confirm without the card pin sends nothing', async () => {
    expect(await preview({}, OWNER)).toMatchObject({ preview: true });
    expect(await executeComposeEmailTool('compose_email', { customer_id: CUST, subject: SUBJECT, body: BODY, confirmed: true }, OWNER)).toMatchObject({ code: 'approval_required' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('shows To (name and address), From, subject, the exact body and every effect; sends nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'compose_email', from: 'Waves Pest Control <office@example.invalid>', subject: SUBJECT, body: BODY, sends_to_customer: true,
      pinned_recipient: { name: 'Robin Sample', email: 'robin.sample@example.invalid', customer_id: CUST, linked_customer: true },
      to_label: 'Robin Sample <robin.sample@example.invalid>', to_note: 'a customer on file',
    });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/One new email goes to Robin Sample <robin\.sample@example\.invalid> from Waves Pest Control <office@example\.invalid>\. It starts a new thread; it is not a reply\./);
    expect(text).toMatch(/plain text, exactly as shown\. No signature, attachment, tracking link or unsubscribe link/);
    expect(text).toMatch(/No opt-out or suppression check runs/);
    expect(text).toMatch(/Portal links to a customer's account .* are refused in the body/);
    expect(text).toMatch(/No copy is saved or linked to the customer\. The message appears in the Gmail Sent folder/);
    expect(text).toMatch(/result is reported as unknown and nothing is retried/);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockLinkRefusal).toHaveBeenCalledWith({ body: BODY });
  });

  test('the contract: a card line per fact, the whole body under Show more, irreversible, customer contact only for a customer', async () => {
    const card = await preview();
    const lines = cardLines('compose_email', card).map((l) => l.text);
    expect(lines).toEqual(expect.arrayContaining([
      'To: Robin Sample <robin.sample@example.invalid> (a customer on file)',
      'From: Waves Pest Control <office@example.invalid>',
      `Subject: ${SUBJECT}`,
      `Full body, exactly as sent:\n${BODY}`,
    ]));
    const contract = buildContract({ toolName: 'compose_email', params: { customer_id: CUST }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.irreversible).toBe(true);
    expect(contract.notifies_customer).toBe(true);
    expect(contract.more_effects.map((e) => e.label)).toContain(`Full body, exactly as sent:\n${BODY}`);
    expect(contract.effects.map((e) => e.label)).toEqual(expect.arrayContaining([`Subject: ${SUBJECT}`]));
    expect(contract.pinned_recipient).toMatchObject({ email: 'robin.sample@example.invalid' });
    const stranger = await preview({ customer_id: undefined, email_address: 'office@vendor.example' });
    const strangerContract = buildContract({ toolName: 'compose_email', params: {}, displayParams: {}, preview: stranger, summary: 'x' });
    expect(strangerContract.notifies_customer).toBe(false);
    expect(strangerContract.irreversible).toBe(true);
  });

  test('a short one-line body is shown whole on the card, with no Show more entry', async () => {
    const card = await preview({ body: 'See you tomorrow.' });
    const lines = cardLines('compose_email', card);
    expect(lines.find((l) => l.text.startsWith('Body:')).text).toBe('Body: See you tomorrow.');
    expect(lines.some((l) => l.more)).toBe(false);
  });

  test('the route builds the confirmation card from this preview', async () => {
    const { confirmationDisplayParams } = jest.requireActual('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('compose_email', {}, await preview())).toEqual({
      to: 'Robin Sample <robin.sample@example.invalid>', from: 'Waves Pest Control <office@example.invalid>', subject: SUBJECT, body: BODY, sends: 'one new email',
    });
  });

  test('a typed address: the customer it matches, none, or several', async () => {
    expect(await preview({ customer_id: undefined, email_address: ' ROBIN.SAMPLE@example.invalid ' })).toMatchObject({
      pinned_recipient: { customer_id: CUST, email: 'robin.sample@example.invalid', name: 'Robin Sample' },
    });
    const stranger = await preview({ customer_id: undefined, email_address: 'office@vendor.example' });
    expect(stranger).toMatchObject({ sends_to_customer: false, to_label: 'office@vendor.example', to_note: 'not a customer on file', pinned_recipient: { customer_id: null, linked_customer: false } });
    S.customers.push({ ...S.customers[0], id: '00000000-0000-4000-8000-0000000000c2', first_name: 'Rory' });
    expect(await preview({ customer_id: undefined, email_address: 'robin.sample@example.invalid' })).toMatchObject({ to_note: '2 customers share this address', pinned_recipient: { customer_id: null } });
  });

  test.each([
    ['no selector', { customer_id: undefined }, 'invalid_target'],
    ['both selectors', { email_address: 'a@example.invalid' }, 'invalid_target'],
    ['a bad customer id', { customer_id: 'nope' }, 'invalid_target'],
    ['an unknown customer', { customer_id: '00000000-0000-4000-8000-0000000000ff' }, 'customer_not_found'],
    ['two addresses', { customer_id: undefined, email_address: 'a@example.invalid, b@example.invalid' }, 'invalid_address'],
    ['a display-name address', { customer_id: undefined, email_address: 'Robin <a@example.invalid>' }, 'invalid_address'],
    ['a semicolon list', { customer_id: undefined, email_address: 'a@example.invalid;b@example.invalid' }, 'invalid_address'],
    ['no domain dot', { customer_id: undefined, email_address: 'a@example' }, 'invalid_address'],
    ['an empty subject', { subject: '   ' }, 'invalid_subject'],
    ['a two-line subject', { subject: 'Hi\nBcc: x@example.invalid' }, 'invalid_subject'],
    ['a too-long subject', { subject: 'x'.repeat(201) }, 'invalid_subject'],
    ['an empty body', { body: ' \n ' }, 'invalid_body'],
    ['a too-long body', { body: 'x'.repeat(5001) }, 'invalid_body'],
    ['a control character in the body', { body: 'Hi\u0000there' }, 'invalid_body'],
  ])('refused: %s', async (_label, input, code) => {
    expect(await preview(input)).toMatchObject({ code });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a customer with no email on file is refused with the fix', async () => {
    S.customers[0].email = null;
    const refused = await preview();
    expect(refused).toMatchObject({ code: 'no_email_on_file' });
    expect(refused.error).toMatch(/no email on file/);
    S.customers[0].email = 'not-an-address';
    expect(await preview()).toMatchObject({ code: 'invalid_address' });
  });

  test('a portal link in the body is refused with the reply tool\'s own check; no card', async () => {
    mockLinkRefusal.mockResolvedValue({ success: false, error: 'Links to a customer account cannot be emailed from the bar', blocked: true, code: 'customer_link_refused' });
    expect(await preview()).toMatchObject({ code: 'customer_link_refused', blocked: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe('the confirmed run', () => {
  test('sends exactly the carded fields once: the carded address, subject and body, encoded as the page composer encodes it, as a new thread', async () => {
    const card = await preview();
    const done = await confirm(card);
    expect(done).toMatchObject({ success: true, state: 'provider_accepted', providerMessageId: 'gmail-msg-1', sent_to: 'robin.sample@example.invalid', subject: SUBJECT, sent_to_customer: true });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith('robin.sample@example.invalid', SUBJECT, encodeEmailBody(BODY), undefined, undefined);
    expect(mockSendMessage.mock.calls[0][2]).toBe('Hi Robin,<br>We will be there tomorrow between 9 and 11. R&amp;D note: price &lt;100.<br>Thanks, Waves');
  });

  test('a typed address for a stranger sends to that address and reports no customer contact', async () => {
    const card = await preview({ customer_id: undefined, email_address: 'office@vendor.example' });
    expect(await confirm(card, { customer_id: undefined, email_address: 'office@vendor.example' })).toMatchObject({ success: true, sent_to_customer: false });
    expect(mockSendMessage.mock.calls[0][0]).toBe('office@vendor.example');
  });

  test.each([
    ['the customer\'s email changed', () => { S.customers[0].email = 'new.address@example.invalid'; }, {}],
    ['the customer was renamed', () => { S.customers[0].first_name = 'Robyn'; }, {}],
    ['the customer was removed', () => { S.customers[0].deleted_at = new Date(); }, {}],
    ['the subject differs from the card', () => {}, { subject: 'Another subject' }],
    ['the body differs by one character', () => {}, { body: `${BODY}!` }],
    ['the body differs only in a link-like token', () => {}, { body: BODY.replace('tomorrow', 'today') }],
  ])('%s after the card: refused, nothing sent', async (_label, change, override) => {
    const card = await preview();
    change();
    expect(await confirm(card, override)).toMatchObject({ preview_changed: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('an address that now belongs to a customer (or to two) is a different card: refused', async () => {
    const card = await preview({ customer_id: undefined, email_address: 'office@vendor.example' });
    S.customers.push({ id: '00000000-0000-4000-8000-0000000000c3', first_name: 'Val', last_name: 'Vendor', company_name: null, email: 'office@vendor.example', deleted_at: null });
    expect(await confirm(card, { customer_id: undefined, email_address: 'office@vendor.example' })).toMatchObject({ code: 'preview_changed' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a body that picked up a portal link between the card and Confirm is refused', async () => {
    const card = await preview();
    mockLinkRefusal.mockResolvedValue({ success: false, error: 'blocked', blocked: true, code: 'customer_link_refused' });
    expect(await confirm(card)).toMatchObject({ preview_changed: true, code: 'customer_link_refused' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('no pin refuses', async () => {
    expect(await executeComposeEmailTool('compose_email', { customer_id: CUST, subject: SUBJECT, body: BODY, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a second run of the same confirmed operation never sends again', async () => {
    const card = await preview();
    const ctx = { ...ADMIN, operationId: 'same-op' };
    expect(await confirm(card, {}, ctx)).toMatchObject({ success: true });
    expect(await confirm(card, {}, ctx)).toMatchObject({ failed: true, code: 'duplicate_confirm' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('Gmail gave no id, or timed out: outcome_unknown, never success, never retried', async () => {
    const card = await preview();
    mockSendMessage.mockResolvedValueOnce({});
    const noId = await confirm(card);
    expect(noId).toMatchObject({ outcome_unknown: true });
    expect(noId.success).toBeUndefined();
    mockSendMessage.mockRejectedValueOnce(Object.assign(new Error('timeout'), { providerOutcome: { outcomeUnknown: true } }));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  test('Gmail refused it: failed, with no claim that anything was sent', async () => {
    const card = await preview();
    mockSendMessage.mockRejectedValueOnce(new Error('Pre-send failure'));
    const out = await confirm(card);
    expect(out).toMatchObject({ failed: true, code: 'send_not_accepted' });
    expect(out.success).toBeUndefined();
    expect(out.error).toMatch(/nothing was sent/);
  });
});

describe('customer-scoped tasks hold the recipient to the task customer', () => {
  const TaskContext = jest.requireActual('../services/intelligence-bar/task-context');

  test('the task customer by id or by their own saved address passes; anyone else is refused; owner-direct passes', async () => {
    const context = { targets: [{ customer_id: CUST }] };
    expect(await TaskContext.validateComposeRecipient({ customer_id: CUST }, context)).toBeNull();
    expect(await TaskContext.validateComposeRecipient({ customer_id: '00000000-0000-4000-8000-0000000000c9' }, context)).toMatchObject({ code: 'target_relationship_mismatch' });
    expect(await TaskContext.validateComposeRecipient({ email_address: 'Robin.Sample@Example.invalid' }, context)).toBeNull();
    expect(await TaskContext.validateComposeRecipient({ email_address: 'office@vendor.example' }, context)).toMatchObject({ code: 'target_clarification_required' });
    expect(await TaskContext.validateComposeRecipient({ email_address: 'office@vendor.example' }, { ...context, ownerDirect: true })).toBeNull();
    expect(await TaskContext.validateComposeRecipient({ email_address: 'office@vendor.example' }, {})).toBeNull();
  });
});

describe('the Email page route and the shared send', () => {
  const fs = require('fs');
  const path = require('path');

  test('POST /send calls the shared sendEmailMessage and answers with its status and body', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-email.js'), 'utf8');
    const start = source.indexOf("router.post('/send'");
    const route = source.slice(start, source.indexOf('\n});\n', start));
    expect(route).toContain('await sendEmailMessage({ to, subject, body, threadId, inReplyTo })');
    expect(route).toContain('res.status(status).json(json)');
    expect(route).toContain("res.status(400).json({ status: 'failed', error: 'to and body required' })");
  });

  test('encodeEmailBody mirrors the page composer\'s encoding, character for character', () => {
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/email/useEmailEditor.js'), 'utf8');
    const start = client.indexOf('export function encodeEmailBody');
    const fn = client.slice(start, client.indexOf('\n}\n', start));
    const replaces = [...fn.matchAll(/\.replace\((\/[^/]+\/g), "([^"]*)"\)/g)].map((m) => [m[1], m[2]]);
    expect(replaces).toEqual([['/&/g', '&amp;'], ['/</g', '&lt;'], ['/>/g', '&gt;'], ['/"/g', '&quot;'], ['/\\n/g', '<br>']]);
    expect(encodeEmailBody('a & b <c> "d"\ne')).toBe('a &amp; b &lt;c&gt; &quot;d&quot;<br>e');
  });
});
