/**
 * IB suggested replies (owner ask 2026-10-28, GATE_IB_MESSAGE_DRAFTS): list the AI-suggested replies waiting on the
 * Communications page, and approve / revise / ignore one behind a card. What the cards show (the exact text, the recipient
 * name and masked number, the inbound message answered), that approve and revise are ALWAYS carded (never owner-direct), the
 * refusals (not found, already handled, campaign / estimate-question / photo-triage lanes, a composer-only link, an opted-out
 * number), pin drift (the draft text, the recipient, the newest inbound text), gate off, admin only, and that the commit runs
 * the page's handler once with the carded pins. The handlers are mocked here; admin-drafts-bar-seam.test.js runs the real
 * ones with a mocked sender and intelligence-bar-message-drafts-postgres.test.js runs them on real Postgres. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRoute = {
  _internals: {
    resolveDraftRecipient: jest.fn(),
    latestInboundFrom: jest.fn(),
    draftImmediateOnlyLinkRefusal: jest.fn(),
    isPlainReplyDraft: (d) => !d.campaign_type && d.intent !== 'estimate_clarify' && d.intent !== 'photo_triage',
  },
  approveDraftFromBar: jest.fn(),
  reviseDraftFromBar: jest.fn(),
  rejectDraftFromBar: jest.fn(),
};
jest.mock('../routes/admin-drafts', () => mockRoute);
const mockProposalRefusal = jest.fn();
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  sendSmsProposalRefusal: (...a) => mockProposalRefusal(...a),
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
}));

const db = require('../models/db');
const { executeMessageDraftTool, MESSAGE_DRAFT_TOOLS, cardLines } = require('../services/intelligence-bar/message-draft-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const ID = '00000000-0000-4000-8000-00000000d701';
const CUST = '00000000-0000-4000-8000-00000000d703';
const LOG = '00000000-0000-4000-8000-00000000d702';
const PHONE = '+19415550142';
const TEXT = 'Yes, Thursday works. See you then!';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };

let state;
const freshState = () => ({
  draft: { id: ID, sms_log_id: LOG, customer_id: CUST, inbound_message: 'Can you come Thursday?', draft_response: TEXT, status: 'pending', intent: 'scheduling', campaign_type: null, flags: {}, created_at: '2026-10-28T12:00:00Z' },
  customer: { first_name: 'Robin', last_name: 'Sample', phone: PHONE },
  listRows: [], counts: [],
  readBack: { status: 'approved', sent_at: null },
});

// A knex stand-in keyed on the table each read uses. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { counted: false };
    const rows = () => {
      if (table === 'message_drafts as d') return q.counted ? [{ count: String(state.counts.shift() ?? 0) }] : state.listRows;
      if (table === 'message_drafts') return q.first ? (q.cols ? state.readBack : state.draft) : [state.draft];
      if (table === 'customers') return q.first ? state.customer : [state.customer];
      return [];
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'catch') return () => b;
        if (prop === 'first') return (...cols) => { q.first = true; q.cols = cols.length > 0; return b; };
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
  if (on) { process.env.GATE_IB_MESSAGE_DRAFTS = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_MESSAGE_DRAFTS; delete process.env.GATE_IB_PLATFORM; }
}

const run = (tool, input = {}, ctx = ADMIN) => executeMessageDraftTool(tool, input, ctx);
const confirm = (tool, card, input = {}, ctx = ADMIN) => run(tool, { draft_id: ID, ...input, confirmed: true, _verified_draft_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockRoute._internals.resolveDraftRecipient.mockResolvedValue({ toPhone: PHONE, customerId: CUST });
  mockRoute._internals.latestInboundFrom.mockResolvedValue({ id: LOG, created_at: '2026-10-28T12:00:00Z' });
  mockRoute._internals.draftImmediateOnlyLinkRefusal.mockResolvedValue(null);
  mockProposalRefusal.mockResolvedValue(null);
  mockRoute.approveDraftFromBar.mockResolvedValue({ status: 200, json: { success: true, responseTimeSeconds: 60 } });
  mockRoute.reviseDraftFromBar.mockResolvedValue({ status: 200, json: { success: true, responseTimeSeconds: 60 } });
  mockRoute.rejectDraftFromBar.mockResolvedValue({ status: 200, json: { success: true } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('three two-step writes and one read, admin only, comms domain', () => {
    for (const name of ['approve_suggested_reply', 'revise_suggested_reply', 'ignore_suggested_reply']) {
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
      expect(registry.actions.get(name)).toMatchObject({ domain: 'comms', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'message-draft-tools.js' });
      expect(MESSAGE_DRAFT_TOOLS.find((t) => t.name === name)._sideEffects).toBe(true);
    }
    expect(registry.actions.get('list_suggested_replies')).toMatchObject({ domain: 'comms', role: 'admin', approval: null, kind: 'read', scope: 'broad' });
    expect(registry.policyErrors).not.toEqual(expect.arrayContaining(['list_suggested_replies', 'approve_suggested_reply', 'revise_suggested_reply', 'ignore_suggested_reply']));
  });

  test('never card-free: none of them is on the owner-direct list', () => {
    for (const name of ['approve_suggested_reply', 'revise_suggested_reply', 'ignore_suggested_reply']) {
      expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
      expect(ownerDirect.mayExecuteWithoutCard(name, { draft_id: ID })).toBe(false);
    }
  });

  test('offered to an admin on the Communications page while on; gone with either gate off; never for a technician', () => {
    const names = (scope) => registry.initialTools('comms', scope).map((d) => d.name);
    expect(names({ role: 'admin' })).toEqual(expect.arrayContaining(['list_suggested_replies', 'approve_suggested_reply', 'revise_suggested_reply', 'ignore_suggested_reply']));
    delete process.env.GATE_IB_MESSAGE_DRAFTS;
    expect(names({ role: 'admin' })).not.toContain('approve_suggested_reply');
    envGate(true);
    delete process.env.GATE_IB_PLATFORM;
    expect(names({ role: 'admin' })).not.toContain('list_suggested_replies');
    envGate(true);
    for (const name of ['list_suggested_replies', 'approve_suggested_reply']) {
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
    }
  });

  test('through the registry: the schema rejects smuggled fields, and a model cannot confirm by itself', async () => {
    const scope = { role: 'admin', context: 'comms', actionContext: { isAdmin: true, technicianId: 'staff-1' } };
    expect(await registry.execute('approve_suggested_reply', { draft_id: ID, confirmed: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('revise_suggested_reply', { draft_id: ID }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('approve_suggested_reply', { draft_id: ID }, scope)).toMatchObject({ preview: true });
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test('discoverable by the operator\'s words', () => {
    for (const query of ['approve suggested reply', 'pending suggested replies', 'dismiss the suggested reply']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name).some((n) => n.endsWith('_suggested_reply') || n === 'list_suggested_replies')).toBe(true);
    }
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing runs', async () => {
    envGate(false);
    expect(await run('approve_suggested_reply', { draft_id: ID })).toMatchObject({ code: 'gate_off' });
    expect(await run('list_suggested_replies')).toMatchObject({ code: 'gate_off' });
    expect(await run('approve_suggested_reply', { draft_id: ID, confirmed: true, _verified_draft_version: {} })).toMatchObject({ code: 'gate_off' });
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await run('approve_suggested_reply', { draft_id: ID }, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await run('list_suggested_replies', {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await run('approve_suggested_reply', { draft_id: ID, confirmed: true, _verified_draft_version: {} }, {})).toMatchObject({ code: 'permission_denied' });
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test('the owner login gets the same card: the preview is the same whatever the login', async () => {
    const owner = { isAdmin: true, fullAccess: true, technicianId: null };
    const a = await run('approve_suggested_reply', { draft_id: ID }, owner);
    const b = await run('approve_suggested_reply', { draft_id: ID }, ADMIN);
    expect(a.preview).toBe(true);
    expect(a).toEqual(b);
  });
});

describe('list_suggested_replies', () => {
  test('oldest first, masked number, counts the other lanes, no raw phone', async () => {
    state.listRows = [{ id: ID, customer_id: CUST, sms_log_id: LOG, inbound_message: 'Can you come Thursday?', draft_response: TEXT, flags: {}, created_at: new Date(Date.now() - 90 * 60000).toISOString(), first_name: 'Robin', last_name: 'Sample', phone: PHONE }];
    state.counts = [1, 4];
    const out = await run('list_suggested_replies');
    expect(out).toMatchObject({ pending_replies: 1, returned_count: 1, other_pending_on_communications_page: 3 });
    expect(out.suggested_replies[0]).toMatchObject({ draft_id: ID, customer: 'Robin Sample', sends_to: '…0142', inbound_message: 'Can you come Thursday?', suggested_reply: TEXT });
    expect(out.suggested_replies[0].waiting_minutes).toBeGreaterThanOrEqual(89);
    expect(JSON.stringify(out)).not.toContain('9415550142');
  });
});

describe('approve_suggested_reply preview', () => {
  test('shows the exact text, the recipient and the inbound message, and writes nothing', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    expect(card).toMatchObject({
      preview: true, tool: 'approve_suggested_reply', draft_id: ID, customer_name: 'Robin Sample', recipient: 'Robin Sample (…0142)',
      inbound_message: 'Can you come Thursday?', final_text: TEXT, sends_to_customer: true, newer_inbound: false,
    });
    expect(card._version).toMatchObject({ action: 'approve', draft_id: ID, status: 'pending', draft_text: TEXT, final_text: TEXT, recipient_phone: PHONE, customer_id: CUST, latest_inbound_id: LOG });
    expect(JSON.stringify({ ...card, _version: undefined })).not.toContain('9415550142');
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
    const lines = cardLines('approve_suggested_reply', card).map((l) => l.text);
    expect(lines[0]).toBe(`Text to Robin Sample (…0142): "${TEXT}"`);
    expect(lines).toContain('Answers their message: "Can you come Thursday?"');
    expect(lines).toContain('The text cannot be unsent.');
  });

  test('the contract marks it a customer text that cannot be undone, with the card lines', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    const contract = buildContract({ toolName: 'approve_suggested_reply', params: { draft_id: ID }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.irreversible).toBe(true);
    expect(JSON.stringify(contract)).toContain(TEXT);
    expect(JSON.stringify(contract)).toContain('…0142');
    expect(contract.customer_contact ?? contract.customerContact ?? true).toBeTruthy();
  });

  test('flags a newer text from the customer on the card', async () => {
    mockRoute._internals.latestInboundFrom.mockResolvedValue({ id: 'log-newer' });
    const card = await run('approve_suggested_reply', { draft_id: ID });
    expect(card.newer_inbound).toBe(true);
    expect(cardLines('approve_suggested_reply', card).map((l) => l.text).join(' ')).toContain('newer text');
  });

  test.each([
    ['unknown draft', (s) => { s.draft = undefined; }, 'draft_not_found'],
    ['bad id', null, 'invalid_target', { draft_id: 'nope' }],
    ['already approved', (s) => { s.draft.status = 'approved'; }, 'already_handled'],
    ['already ignored', (s) => { s.draft.status = 'rejected'; }, 'already_handled'],
    ['a campaign draft', (s) => { s.draft.campaign_type = 'upsell'; }, 'needs_communications_page'],
    ['an estimate question', (s) => { s.draft.intent = 'estimate_clarify'; }, 'needs_communications_page'],
    ['a photo-triage draft', (s) => { s.draft.intent = 'photo_triage'; }, 'needs_communications_page'],
    ['an empty draft', (s) => { s.draft.draft_response = '  '; }, 'draft_empty'],
  ])('refuses %s with no card', async (_label, mutate, code, input = { draft_id: ID }) => {
    if (mutate) mutate(state);
    expect(await run('approve_suggested_reply', input)).toMatchObject({ code });
  });

  test('refuses when no recipient number can be found', async () => {
    mockRoute._internals.resolveDraftRecipient.mockResolvedValue({ toPhone: null, customerId: null });
    expect(await run('approve_suggested_reply', { draft_id: ID })).toMatchObject({ code: 'no_recipient' });
  });

  test('refuses a link only the composer may send, and an opted-out number', async () => {
    mockRoute._internals.draftImmediateOnlyLinkRefusal.mockResolvedValue('Auto Pay setup links cannot go out through draft approval.');
    expect(await run('approve_suggested_reply', { draft_id: ID })).toMatchObject({ code: 'needs_communications_page' });
    mockRoute._internals.draftImmediateOnlyLinkRefusal.mockResolvedValue(null);
    mockProposalRefusal.mockResolvedValue({ success: false, error: 'Customer opted out', code: 'OPTED_OUT', blocked: true });
    expect(await run('approve_suggested_reply', { draft_id: ID })).toMatchObject({ code: 'OPTED_OUT', blocked: true });
  });
});

// The sender (send-customer-message.js) delivers normalizeGsmPunctuation(stripSmsUrlScheme(body)); the card must show that text.
describe('the card shows what the sender delivers', () => {
  const SMART = 'We\u2019ll be there Thursday \u2014 \u201Cmorning\u201D. Details: https://wavespestcontrol.com/appointments/abc';
  const delivered = (t) => normalizeGsmPunctuation(stripSmsUrlScheme(t));

  test('approve: final_text is the delivered text; the raw draft stays the claim\'s pin', async () => {
    state.draft.draft_response = SMART;
    const card = await run('approve_suggested_reply', { draft_id: ID });
    expect(card.final_text).toBe(delivered(SMART));
    expect(card.final_text).not.toMatch(/[\u2019\u2014\u201C\u201D]|https:\/\//);
    expect(card.final_text).toContain('wavespestcontrol.com/appointments/abc');
    expect(card._version).toMatchObject({ draft_text: SMART, final_text: delivered(SMART) });
    expect(cardLines('approve_suggested_reply', card)[0].text).toBe(`Text to Robin Sample (\u20260142): "${delivered(SMART)}"`);
    const out = await confirm('approve_suggested_reply', card);
    expect(out.sent_text).toBe(delivered(SMART));
    expect(mockRoute.approveDraftFromBar).toHaveBeenCalledWith(expect.objectContaining({ pins: expect.objectContaining({ draftText: SMART }) }));
  });

  test('revise: a smart-punctuation, https revision is carded and posted as the delivered text', async () => {
    const revised = 'Thursday at 10 \u2013 we\u2019ll see you. https://wavespestcontrol.com/pay/xyz';
    const card = await run('revise_suggested_reply', { draft_id: ID, revised_text: revised });
    expect(card.final_text).toBe(delivered(revised));
    expect(card.suggested_text).toBe(TEXT);
    const out = await confirm('revise_suggested_reply', card, { revised_text: revised });
    expect(out.sent_text).toBe(delivered(revised));
    expect(mockRoute.reviseDraftFromBar).toHaveBeenCalledWith(expect.objectContaining({ body: { revisedResponse: delivered(revised) } }));
  });

  test('a revision that differs only by punctuation the sender normalizes is the same text', async () => {
    state.draft.draft_response = 'We\u2019ll see you then.';
    expect(await run('revise_suggested_reply', { draft_id: ID, revised_text: "We'll see you then." })).toMatchObject({ code: 'same_as_suggestion' });
  });

  test('the link check sees the raw draft as well as the delivered text', async () => {
    state.draft.draft_response = SMART;
    await run('approve_suggested_reply', { draft_id: ID });
    const seen = mockRoute._internals.draftImmediateOnlyLinkRefusal.mock.calls.map((c) => c[0]);
    expect(seen).toEqual(expect.arrayContaining([SMART, delivered(SMART)]));
  });
});

// The sender shortens owned portal links at delivery (sms-link-wrap.js, GATE_SMS_LINK_WRAP) and, for receipt-type purposes, rewrites withheld
// estimate links. The card says so, judged by the sender's own read-only predicates; no link that qualifies, no note.
describe('links the sender rewrites at delivery', () => {
  const NOTE = 'The portal link goes out as a tracked short link.';
  const PORTAL = 'Pay here: https://portal.wavespestcontrol.com/pay/abc123def';
  afterEach(() => { delete process.env.GATE_SMS_LINK_WRAP; jest.restoreAllMocks(); });

  test('wrap gate on and an owned portal link in the text: one plain line on the card, pinned, nothing minted', async () => {
    process.env.GATE_SMS_LINK_WRAP = 'true';
    const shortUrl = require('../services/short-url');
    const mint = jest.spyOn(shortUrl, 'createShortCode');
    state.draft.draft_response = PORTAL;
    const card = await run('approve_suggested_reply', { draft_id: ID });
    expect(card.link_notes).toEqual([NOTE]);
    expect(card._version.link_notes).toEqual([NOTE]);
    expect(cardLines('approve_suggested_reply', card).map((l) => l.text)).toContain(NOTE);
    expect(mint).not.toHaveBeenCalled();
  });

  test('a revision with a portal link carries the note too', async () => {
    process.env.GATE_SMS_LINK_WRAP = 'true';
    const card = await run('revise_suggested_reply', { draft_id: ID, revised_text: 'Pay here: https://portal.wavespestcontrol.com/pay/abc123def' });
    expect(card.link_notes).toEqual([NOTE]);
  });

  test.each([
    ['the wrap gate is off', false, 'Pay here: https://portal.wavespestcontrol.com/pay/abc123def'],
    ['a plain website link (not an owned portal link)', true, 'See https://wavespestcontrol.com/pest-control/ for more.'],
    ['a review link (the sender leaves it)', true, 'Rate us: https://portal.wavespestcontrol.com/rate/abc123def'],
    ['no link at all', true, 'Yes, Thursday works. See you then!'],
  ])('no note when %s', async (_label, gateOn, text) => {
    if (gateOn) process.env.GATE_SMS_LINK_WRAP = 'true';
    state.draft.draft_response = text;
    const card = await run('approve_suggested_reply', { draft_id: ID });
    expect(card.link_notes).toEqual([]);
    expect(cardLines('approve_suggested_reply', card).map((l) => l.text).join(' ')).not.toMatch(/short link|portal home/);
  });

  test('ignore has no note', async () => {
    process.env.GATE_SMS_LINK_WRAP = 'true';
    state.draft.draft_response = PORTAL;
    expect((await run('ignore_suggested_reply', { draft_id: ID })).link_notes).toEqual([]);
  });

  test('an estimate link the sender would rewrite (receipt-type purpose, link no longer offered) is named; otherwise not', async () => {
    const Annual = require('../services/estimate-annual-guard');
    jest.spyOn(Annual, 'withheldLinkPolicyForSmsPurpose').mockReturnValue('rewrite');
    const rewrite = jest.spyOn(Annual, 'rewriteWithheldEstimateLinks').mockResolvedValue({ text: 'x', rewrittenIds: ['est-1'] });
    expect((await run('approve_suggested_reply', { draft_id: ID })).link_notes).toEqual(['An estimate link that is no longer offered goes out as the portal home link.']);
    rewrite.mockResolvedValue({ text: 'x', rewrittenIds: [] });
    expect((await run('approve_suggested_reply', { draft_id: ID })).link_notes).toEqual([]);
  });

  test('the bar\'s own send purposes are the refuse policy: the estimate rewrite never applies, so no estimate note', async () => {
    const Annual = require('../services/estimate-annual-guard');
    expect(Annual.withheldLinkPolicyForSmsPurpose('conversational', 'ai_approved')).toBe('refuse');
  });
});

describe('revise_suggested_reply preview', () => {
  const REVISED = 'Thursday at 10 works. See you then!';
  test('the card shows the final text and the original suggestion', async () => {
    const card = await run('revise_suggested_reply', { draft_id: ID, revised_text: `  ${REVISED}  ` });
    expect(card).toMatchObject({ preview: true, action: 'revise', final_text: REVISED, suggested_text: TEXT, recipient: 'Robin Sample (…0142)' });
    expect(card._version).toMatchObject({ action: 'revise', draft_text: TEXT, final_text: REVISED });
    const lines = cardLines('revise_suggested_reply', card).map((l) => l.text);
    expect(lines[0]).toBe(`Text to Robin Sample (…0142): "${REVISED}"`);
    expect(lines[1]).toBe(`Edited from the suggestion: "${TEXT}"`);
    expect(mockProposalRefusal).toHaveBeenCalledWith(expect.objectContaining({ message: REVISED }));
  });

  test.each([
    ['the same text', { revised_text: TEXT }, 'same_as_suggestion'],
    ['no text', { revised_text: '   ' }, 'invalid_target'],
    ['a text over the limit', { revised_text: 'x'.repeat(1601) }, 'text_too_long'],
  ])('refuses %s', async (_label, input, code) => {
    expect(await run('revise_suggested_reply', { draft_id: ID, ...input })).toMatchObject({ code });
  });
});

describe('ignore_suggested_reply preview', () => {
  test('names who it was for and says nothing is sent', async () => {
    const card = await run('ignore_suggested_reply', { draft_id: ID });
    expect(card).toMatchObject({ preview: true, action: 'ignore', sends_to_customer: false });
    const text = cardLines('ignore_suggested_reply', card).map((l) => l.text).join(' ');
    expect(text).toContain('Dismiss the suggested reply for Robin Sample (…0142)');
    expect(text).toContain('Nothing is sent');
    expect(mockProposalRefusal).not.toHaveBeenCalled();
  });

  test('still works when the recipient number cannot be found', async () => {
    mockRoute._internals.resolveDraftRecipient.mockResolvedValue({ toPhone: null, customerId: null });
    expect(await run('ignore_suggested_reply', { draft_id: ID })).toMatchObject({ preview: true });
  });
});

describe('confirm', () => {
  test('needs the card: no pinned version, nothing runs', async () => {
    expect(await run('approve_suggested_reply', { draft_id: ID, confirmed: true })).toMatchObject({ code: 'approval_required' });
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test('approve runs the page handler once with the carded pins and reports the send', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    const out = await confirm('approve_suggested_reply', card);
    expect(out).toMatchObject({ success: true, state: 'provider_accepted', sent_to_customer: true, sent_text: TEXT, recipient: 'Robin Sample (…0142)' });
    expect(mockRoute.approveDraftFromBar).toHaveBeenCalledTimes(1);
    expect(mockRoute.approveDraftFromBar).toHaveBeenCalledWith({
      draftId: ID, actor: { technicianId: 'staff-1' }, body: {},
      pins: { draftText: TEXT, recipientPhone: PHONE, customerId: CUST, latestInboundId: LOG },
    });
  });

  test('revise sends exactly the carded text, never a later model edit', async () => {
    const card = await run('revise_suggested_reply', { draft_id: ID, revised_text: 'Thursday at 10 works.' });
    expect(await confirm('revise_suggested_reply', card, { revised_text: 'Something else entirely.' })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockRoute.reviseDraftFromBar).not.toHaveBeenCalled();
    const out = await confirm('revise_suggested_reply', card, { revised_text: 'Thursday at 10 works.' });
    expect(out).toMatchObject({ success: true, sent_text: 'Thursday at 10 works.' });
    expect(mockRoute.reviseDraftFromBar).toHaveBeenCalledWith(expect.objectContaining({ body: { revisedResponse: 'Thursday at 10 works.' } }));
  });

  test('ignore runs the reject handler and sends nothing', async () => {
    const card = await run('ignore_suggested_reply', { draft_id: ID });
    expect(await confirm('ignore_suggested_reply', card)).toMatchObject({ success: true, sent_to_customer: false });
    expect(mockRoute.rejectDraftFromBar).toHaveBeenCalledTimes(1);
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['the draft text changed', (s) => { s.draft.draft_response = 'Different suggestion.'; }],
    ['the draft was handled', (s) => { s.draft.status = 'approved'; }],
    ['the draft was ignored', (s) => { s.draft.status = 'rejected'; }],
    ['the recipient number changed', () => { mockRoute._internals.resolveDraftRecipient.mockResolvedValue({ toPhone: '+19415550199', customerId: CUST }); }],
    ['the customer changed', () => { mockRoute._internals.resolveDraftRecipient.mockResolvedValue({ toPhone: PHONE, customerId: '00000000-0000-4000-8000-00000000d799' }); }],
    ['the customer texted again', () => { mockRoute._internals.latestInboundFrom.mockResolvedValue({ id: 'log-newer' }); }],
  ])('%s after the card: preview_changed, nothing sent', async (_label, drift) => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    drift(state);
    const out = await confirm('approve_suggested_reply', card);
    expect(out).toMatchObject({ preview_changed: true });
    expect(['preview_changed', 'already_handled']).toContain(out.code);
    expect(mockRoute.approveDraftFromBar).not.toHaveBeenCalled();
  });

  test('a handler 409 preview_changed (the claim saw the drift) comes back as preview_changed', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    mockRoute.approveDraftFromBar.mockResolvedValue({ status: 409, json: { error: 'changed', code: 'preview_changed', preview_changed: true } });
    expect(await confirm('approve_suggested_reply', card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
  });

  test('a blocked send is reported as blocked, an uncertain carrier outcome as unknown', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    mockRoute.approveDraftFromBar.mockResolvedValue({ status: 422, json: { error: 'Customer opted out', code: 'OPTED_OUT' } });
    expect(await confirm('approve_suggested_reply', card)).toMatchObject({ success: false, blocked: true, code: 'OPTED_OUT' });
    mockRoute.approveDraftFromBar.mockResolvedValue({ status: 409, json: { error: 'The carrier did not confirm this text.', code: 'SMS_DELIVERY_UNCERTAIN', mayHaveSent: true } });
    expect(await confirm('approve_suggested_reply', card)).toMatchObject({ outcome_unknown: true, code: 'sms_delivery_uncertain' });
  });

  test('a handler that throws: read the draft back; sent_at proves the send, otherwise the outcome is unknown', async () => {
    const card = await run('approve_suggested_reply', { draft_id: ID });
    mockRoute.approveDraftFromBar.mockRejectedValue(new Error('db gone'));
    state.readBack = { status: 'approved', sent_at: '2026-10-28T13:00:00Z' };
    expect(await confirm('approve_suggested_reply', card)).toMatchObject({ success: true, warning: true, sent_to_customer: true });
    state.readBack = { status: 'pending', sent_at: null };
    expect(await confirm('approve_suggested_reply', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});
