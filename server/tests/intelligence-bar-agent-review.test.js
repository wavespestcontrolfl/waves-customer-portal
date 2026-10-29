/**
 * IB Agent Review drafts (owner ask 2026-10-28, gap 7, GATE_IB_AGENT_REVIEW_DRAFTS): list the AI-suggested replies waiting in the
 * composer, and approve / revise / ignore one behind a card. What the cards show (the exact text, the recipient name and masked
 * number, the inbound text, lint and promised actions, a newer-text warning), that approve and revise are ALWAYS carded (never
 * owner-direct), the refusals, pin drift (the draft text, the recipient, the newest inbound text), gate off, admin only, that the
 * commit runs the composer's send handler once with the carded body and pins, and how each handler answer is reported. The
 * handler is mocked here; intelligence-bar-agent-review-postgres.test.js runs the real one on Postgres. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockComms = { sendSmsFromBar: jest.fn() };
jest.mock('../routes/admin-communications', () => mockComms);
const mockSuggest = {
  SUGGEST_WORKFLOW: 'sms_house_voice_suggest',
  excludeGatedSchedulingSuggestions: (q) => q,
  decisionIsGatedSchedulingSuggestion: jest.fn(),
  newestInboundIdForThread: jest.fn(),
  ignorePendingSuggestion: jest.fn(),
};
jest.mock('../services/sms-suggest-mode', () => mockSuggest);
const mockProposalRefusal = jest.fn();
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  sendSmsProposalRefusal: (...a) => mockProposalRefusal(...a),
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
}));

const db = require('../models/db');
const { executeAgentReviewTool, AGENT_REVIEW_TOOLS, cardLines } = require('../services/intelligence-bar/agent-review-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const ID = '00000000-0000-4000-8000-00000000a701';
const LOG = '00000000-0000-4000-8000-00000000a702';
const CUST = '00000000-0000-4000-8000-00000000a703';
const PHONE = '+19415550142';
const TEXT = 'Yes, Thursday works. See you then!';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };

let state;
const freshState = () => ({
  decision: {
    id: ID, status: 'pending_review', workflow: 'synthetic_reply_agent', source_channel: 'sms', customer_id: CUST, sms_log_id: LOG,
    suggested_message: TEXT, input_snapshot: { comms_lint: ['promises_a_time'], intended_actions: ['booking'] }, created_at: '2026-10-28T12:00:00Z',
    sms_from_phone: PHONE, sms_to_phone: '+19415550100', inbound_message: 'Can you come Thursday?', first_name: 'Robin', last_name: 'Sample', customer_phone: PHONE,
  },
  listRows: [], counts: [], readBack: { status: 'accepted' },
});

function makeDb() {
  function builder(table) {
    const q = { counted: false };
    const rows = () => {
      if (table === 'agent_decisions as ad') {
        if (q.counted) return [{ count: String(state.counts.shift() ?? 0) }];
        return q.first ? state.decision : state.listRows;
      }
      if (table === 'agent_decisions') return q.first ? state.readBack : [];
      return [];
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'catch') return () => b;
        if (prop === 'first') return () => { q.first = true; return b; };
        if (prop === 'count') return () => { q.counted = true; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  const fn = (table) => builder(table);
  fn.raw = () => 'RAW';
  return fn;
}

function envGate(on) {
  if (on) { process.env.GATE_IB_AGENT_REVIEW_DRAFTS = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_AGENT_REVIEW_DRAFTS; delete process.env.GATE_IB_PLATFORM; }
}

const run = (tool, input = {}, ctx = ADMIN) => executeAgentReviewTool(tool, input, ctx);
const confirm = (tool, card, input = {}, ctx = ADMIN) => run(tool, { decision_id: ID, ...input, confirmed: true, _verified_agent_review_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockSuggest.decisionIsGatedSchedulingSuggestion.mockResolvedValue(false);
  mockSuggest.newestInboundIdForThread.mockResolvedValue(LOG);
  mockSuggest.ignorePendingSuggestion.mockResolvedValue(true);
  mockProposalRefusal.mockResolvedValue(null);
  mockComms.sendSmsFromBar.mockResolvedValue({ status: 200, json: { sent: true, providerMessageId: 'SM_synthetic', deliveryOutcome: 'accepted' } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('three two-step writes and one read, admin only, comms domain', () => {
    for (const name of ['approve_agent_review_draft', 'revise_agent_review_draft', 'ignore_agent_review_draft']) {
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
      expect(registry.actions.get(name)).toMatchObject({ domain: 'comms', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'agent-review-tools.js' });
      expect(AGENT_REVIEW_TOOLS.find((t) => t.name === name)._sideEffects).toBe(true);
    }
    expect(registry.actions.get('list_agent_review_drafts')).toMatchObject({ domain: 'comms', role: 'admin', approval: null, kind: 'read', scope: 'broad' });
    expect(registry.policyErrors).not.toEqual(expect.arrayContaining(['list_agent_review_drafts', 'approve_agent_review_draft']));
  });

  test('never card-free: none of them is on the owner-direct list', () => {
    for (const name of ['approve_agent_review_draft', 'revise_agent_review_draft', 'ignore_agent_review_draft']) {
      expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
      expect(ownerDirect.mayExecuteWithoutCard(name, { decision_id: ID })).toBe(false);
    }
  });

  test('offered to an admin on the Communications page while on; gone with either gate off; never for a technician', () => {
    const names = (scope) => registry.initialTools('comms', scope).map((d) => d.name);
    expect(names({ role: 'admin' })).toEqual(expect.arrayContaining(['list_agent_review_drafts', 'approve_agent_review_draft', 'revise_agent_review_draft', 'ignore_agent_review_draft']));
    delete process.env.GATE_IB_AGENT_REVIEW_DRAFTS;
    expect(names({ role: 'admin' })).not.toContain('approve_agent_review_draft');
    envGate(true);
    delete process.env.GATE_IB_PLATFORM;
    expect(names({ role: 'admin' })).not.toContain('list_agent_review_drafts');
    envGate(true);
    for (const name of ['list_agent_review_drafts', 'approve_agent_review_draft']) {
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
    }
  });

  test('through the registry: the schema rejects smuggled fields, and a model cannot confirm by itself', async () => {
    const scope = { role: 'admin', context: 'comms', actionContext: { isAdmin: true, technicianId: 'staff-1' } };
    expect(await registry.execute('approve_agent_review_draft', { decision_id: ID, confirmed: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('revise_agent_review_draft', { decision_id: ID }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('approve_agent_review_draft', { decision_id: ID }, scope)).toMatchObject({ preview: true });
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing runs', async () => {
    envGate(false);
    expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ code: 'gate_off' });
    expect(await run('list_agent_review_drafts')).toMatchObject({ code: 'gate_off' });
    expect(await run('approve_agent_review_draft', { decision_id: ID, confirmed: true, _verified_agent_review_version: {} })).toMatchObject({ code: 'gate_off' });
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await run('approve_agent_review_draft', { decision_id: ID }, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await run('list_agent_review_drafts', {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await run('approve_agent_review_draft', { decision_id: ID, confirmed: true, _verified_agent_review_version: {} }, {})).toMatchObject({ code: 'permission_denied' });
  });

  test('the owner login gets the same card', async () => {
    const owner = { isAdmin: true, fullAccess: true, technicianId: null };
    expect(await run('approve_agent_review_draft', { decision_id: ID }, owner)).toEqual(await run('approve_agent_review_draft', { decision_id: ID }, ADMIN));
  });
});

describe('list_agent_review_drafts', () => {
  test('oldest first, masked number, lint and promised actions, no raw phone', async () => {
    state.listRows = [{ id: ID, customer_id: CUST, suggested_message: TEXT, input_snapshot: JSON.stringify({ comms_lint: ['x'], intended_actions: ['payment_link'] }), created_at: new Date(Date.now() - 45 * 60000).toISOString(), sms_from_phone: PHONE, inbound_message: 'Can you come Thursday?', first_name: 'Robin', last_name: 'Sample', customer_phone: PHONE }];
    state.counts = [3];
    const out = await run('list_agent_review_drafts');
    expect(out).toMatchObject({ waiting_drafts: 3, returned_count: 1 });
    expect(out.agent_review_drafts[0]).toMatchObject({ decision_id: ID, customer: 'Robin Sample', sends_to: '…0142', suggested_reply: TEXT, lint_failures: ['x'], promised_actions: ['payment_link'] });
    expect(out.agent_review_drafts[0].waiting_minutes).toBeGreaterThanOrEqual(44);
    expect(JSON.stringify(out)).not.toContain('9415550142');
  });
});

describe('approve_agent_review_draft preview', () => {
  test('shows the exact text, the recipient, the inbound text, lint and promised actions; writes nothing', async () => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    expect(card).toMatchObject({
      preview: true, tool: 'approve_agent_review_draft', decision_id: ID, customer_name: 'Robin Sample', recipient: 'Robin Sample (…0142)',
      inbound_message: 'Can you come Thursday?', final_text: TEXT, sends_to_customer: true, newer_inbound: false, from_number: null,
      lint_failures: ['promises_a_time'], promised_actions: ['booking'],
    });
    expect(card._version).toMatchObject({ action: 'approve', decision_id: ID, status: 'pending_review', draft_text: TEXT, final_text: TEXT, to: PHONE, customer_id: CUST, latest_inbound_id: LOG });
    expect(JSON.stringify({ ...card, _version: undefined })).not.toContain('9415550142');
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
    const lines = cardLines('approve_agent_review_draft', card).map((l) => l.text);
    expect(lines[0]).toBe(`Text to Robin Sample (…0142): "${TEXT}"`);
    expect(lines).toContain('Answers their message: "Can you come Thursday?"');
    expect(lines).toContain('The drafter flagged: promises_a_time');
    expect(lines).toContain('The draft promises: booking');
    expect(lines).toContain('The text cannot be unsent.');
  });

  test('the contract marks it a customer text that cannot be undone', async () => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    const contract = buildContract({ toolName: 'approve_agent_review_draft', params: { decision_id: ID }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.irreversible).toBe(true);
    expect(JSON.stringify(contract)).toContain(TEXT);
    expect(JSON.stringify(contract)).toContain('…0142');
  });

  test('a customer line that is not the thread number sends without a customer id; the office line the customer texted rides along', async () => {
    state.decision.customer_phone = '+19415550177';
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    expect(card._version).toMatchObject({ to: PHONE, customer_id: null });
  });

  test('flags a newer text from the customer on the card', async () => {
    mockSuggest.newestInboundIdForThread.mockResolvedValue('log-newer');
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    expect(card.newer_inbound).toBe(true);
    expect(cardLines('approve_agent_review_draft', card).map((l) => l.text).join(' ')).toContain('newer text');
  });

  test.each([
    ['unknown draft', (s) => { s.decision = undefined; }, 'decision_not_found'],
    ['bad id', null, 'invalid_target', { decision_id: 'nope' }],
    ['already accepted', (s) => { s.decision.status = 'accepted'; }, 'already_handled'],
    ['already ignored', (s) => { s.decision.status = 'ignored'; }, 'already_handled'],
    ['superseded', (s) => { s.decision.status = 'superseded'; }, 'already_handled'],
    ['not an sms draft', (s) => { s.decision.source_channel = 'email'; }, 'not_a_reply_draft'],
    ['an empty draft', (s) => { s.decision.suggested_message = '  '; }, 'not_a_reply_draft'],
  ])('refuses %s with no card', async (_label, mutate, code, input = { decision_id: ID }) => {
    if (mutate) mutate(state);
    expect(await run('approve_agent_review_draft', input)).toMatchObject({ code });
  });

  test('refuses a gated scheduling draft, a house-voice draft with suggest mode off, no recipient, and an opted-out number', async () => {
    mockSuggest.decisionIsGatedSchedulingSuggestion.mockResolvedValue(true);
    expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ code: 'not_a_reply_draft' });
    mockSuggest.decisionIsGatedSchedulingSuggestion.mockResolvedValue(false);
    state.decision.workflow = 'sms_house_voice_suggest';
    expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ preview: true });
    const gatesModule = require('../config/feature-gates');
    const spy = jest.spyOn(gatesModule, 'isEnabled').mockImplementation((name) => name !== 'smsSuggestMode');
    try {
      expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ code: 'not_a_reply_draft' });
    } finally { spy.mockRestore(); }
    state.decision.workflow = 'synthetic_reply_agent';
    state.decision.sms_from_phone = null; state.decision.customer_phone = null;
    expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ code: 'no_recipient' });
    state.decision.sms_from_phone = PHONE; state.decision.customer_phone = PHONE;
    mockProposalRefusal.mockResolvedValue({ success: false, error: 'Customer opted out', code: 'OPTED_OUT', blocked: true });
    expect(await run('approve_agent_review_draft', { decision_id: ID })).toMatchObject({ code: 'OPTED_OUT', blocked: true });
  });
});

describe('revise_agent_review_draft preview', () => {
  const REVISED = 'Thursday at 10 works. See you then!';
  test('the card shows the final text and the original draft', async () => {
    const card = await run('revise_agent_review_draft', { decision_id: ID, revised_text: `  ${REVISED}  ` });
    expect(card).toMatchObject({ preview: true, action: 'revise', final_text: REVISED, suggested_text: TEXT });
    const lines = cardLines('revise_agent_review_draft', card).map((l) => l.text);
    expect(lines[0]).toBe(`Text to Robin Sample (…0142): "${REVISED}"`);
    expect(lines[1]).toBe(`Edited from the draft: "${TEXT}"`);
    expect(mockProposalRefusal).toHaveBeenCalledWith(expect.objectContaining({ message: REVISED }));
  });

  test.each([
    ['the same text (whitespace aside)', { revised_text: `${TEXT}  ` }, 'same_as_draft'],
    ['no text', { revised_text: '   ' }, 'invalid_target'],
    ['a text over the limit', { revised_text: 'x'.repeat(1601) }, 'text_too_long'],
  ])('refuses %s', async (_label, input, code) => {
    expect(await run('revise_agent_review_draft', { decision_id: ID, ...input })).toMatchObject({ code });
  });
});

describe('ignore_agent_review_draft preview', () => {
  test('names who it was for and says nothing is sent', async () => {
    const card = await run('ignore_agent_review_draft', { decision_id: ID });
    expect(card).toMatchObject({ preview: true, action: 'ignore', sends_to_customer: false });
    const text = cardLines('ignore_agent_review_draft', card).map((l) => l.text).join(' ');
    expect(text).toContain('Dismiss the Agent Review draft for Robin Sample (…0142)');
    expect(text).toContain('Nothing is sent');
    expect(mockProposalRefusal).not.toHaveBeenCalled();
  });
});

describe('confirm', () => {
  test('needs the card: no pinned version, nothing runs', async () => {
    expect(await run('approve_agent_review_draft', { decision_id: ID, confirmed: true })).toMatchObject({ code: 'approval_required' });
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
  });

  test('approve runs the composer handler once with the Use Draft body and the carded pins', async () => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    const out = await confirm('approve_agent_review_draft', card);
    expect(out).toMatchObject({ success: true, state: 'provider_accepted', sent_to_customer: true, sent_text: TEXT, recipient: 'Robin Sample (…0142)' });
    expect(mockComms.sendSmsFromBar).toHaveBeenCalledTimes(1);
    expect(mockComms.sendSmsFromBar).toHaveBeenCalledWith({
      body: { to: PHONE, body: TEXT, customerId: CUST, agentDecisionId: ID, agentDraft: TEXT },
      actor: { technicianId: 'staff-1' },
      pins: { suggestedMessage: TEXT, latestInboundId: LOG },
    });
  });

  test('revise sends exactly the carded text, never a later model edit; the draft stays the original', async () => {
    const card = await run('revise_agent_review_draft', { decision_id: ID, revised_text: 'Thursday at 10 works.' });
    expect(await confirm('revise_agent_review_draft', card, { revised_text: 'Something else.' })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
    state.readBack = { status: 'corrected' };
    expect(await confirm('revise_agent_review_draft', card, { revised_text: 'Thursday at 10 works.' })).toMatchObject({ success: true, sent_text: 'Thursday at 10 works.' });
    expect(mockComms.sendSmsFromBar.mock.calls[0][0]).toMatchObject({ body: { body: 'Thursday at 10 works.', agentDraft: TEXT }, pins: { suggestedMessage: TEXT } });
  });

  test('ignore records the draft ignored under the thread lock, sends nothing, and refuses when it was handled meanwhile', async () => {
    const card = await run('ignore_agent_review_draft', { decision_id: ID });
    expect(await confirm('ignore_agent_review_draft', card)).toMatchObject({ success: true, sent_to_customer: false });
    expect(mockSuggest.ignorePendingSuggestion).toHaveBeenCalledWith(expect.objectContaining({ decisionId: ID, expectedSuggestedMessage: TEXT, phoneLast10: '9415550142', reviewedBy: 'staff-1' }));
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
    mockSuggest.ignorePendingSuggestion.mockResolvedValue(false);
    expect(await confirm('ignore_agent_review_draft', card)).toMatchObject({ preview_changed: true });
  });

  test.each([
    ['the draft text changed', (s) => { s.decision.suggested_message = 'Different draft.'; }],
    ['the draft was handled', (s) => { s.decision.status = 'accepted'; }],
    ['the draft was retired', (s) => { s.decision.status = 'superseded'; }],
    ['the recipient number changed', (s) => { s.decision.sms_from_phone = '+19415550199'; s.decision.customer_phone = '+19415550199'; }],
    ['the customer changed', (s) => { s.decision.customer_id = '00000000-0000-4000-8000-00000000a799'; }],
    ['the customer texted again', () => { mockSuggest.newestInboundIdForThread.mockResolvedValue('log-newer'); }],
  ])('%s after the card: preview_changed, nothing sent', async (_label, drift) => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    drift(state);
    const out = await confirm('approve_agent_review_draft', card);
    expect(out).toMatchObject({ preview_changed: true });
    expect(mockComms.sendSmsFromBar).not.toHaveBeenCalled();
  });

  test('the handler\'s answers are reported plainly', async () => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    // boundary pin
    mockComms.sendSmsFromBar.mockResolvedValue({ status: 422, json: { sent: false, blocked: true, code: 'preview_changed', reason: 'new text', error: 'new text' } });
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    // the verification's generic 409: the draft was retired
    mockComms.sendSmsFromBar.mockResolvedValue({ status: 409, json: { error: 'This Agent Review draft was just handled elsewhere — refresh the thread before sending.' } });
    state.readBack = { status: 'superseded' };
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ failed: true, code: 'draft_retired' });
    state.readBack = { status: 'accepted' };
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ code: 'preview_changed' });
    // blocked by the sender
    mockComms.sendSmsFromBar.mockResolvedValue({ status: 422, json: { sent: false, blocked: true, code: 'OPTED_OUT', reason: 'Customer opted out', error: 'Customer opted out' } });
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ success: false, blocked: true, code: 'OPTED_OUT' });
    // a suppressed send (sentinel id): nothing left
    mockComms.sendSmsFromBar.mockResolvedValue({ status: 200, json: { sent: true, providerMessageId: 'template-disabled' } });
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ success: true, warning: true, sent_to_customer: false });
    // carrier uncertain
    mockComms.sendSmsFromBar.mockResolvedValue({ status: 422, json: { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_OUTCOME_UNKNOWN', error: 'x' } });
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ outcome_unknown: true });
  });

  test('a handler that throws: the draft read back (accepted or corrected proves the send), otherwise the outcome is unknown', async () => {
    const card = await run('approve_agent_review_draft', { decision_id: ID });
    mockComms.sendSmsFromBar.mockRejectedValue(new Error('db gone'));
    state.readBack = { status: 'accepted' };
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ success: true, warning: true, sent_to_customer: true });
    state.readBack = { status: 'pending_review' };
    expect(await confirm('approve_agent_review_draft', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});
