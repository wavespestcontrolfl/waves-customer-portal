/**
 * Backlink Manager v2 step 4 (PR 3a) — the send under the authority contract
 * (plan §6.4 / §7 / §13), end to end over the shared in-memory store: the real
 * nightly bridge decides the communication instance, the real sender sends it.
 * Pinned: AUTO_OUTREACH only on a clean draft; the policy cap bounds an
 * automatic send inside the claim; the owner's click IS the approval (bound to
 * the draft hash + the recipient review), the send satisfies the instance and
 * consumes the approval; an edited draft spends the old approval; a stale
 * decision, a prior-path row, a non-owner level, a terms-accepting send and a
 * missing row all refuse; the customer exclusion is a hard block, a shared
 * domain needs the owner's acknowledgement, a lookup failure fails closed; the
 * nightly auto-sends what it authorized (never an inline click run) and stops
 * at the cap; the queue's Send action routes to the sender with its refusals
 * mapped.
 */
let mockStore = null;
jest.mock('../models/db', () => { const fn = (t) => mockStore(t); fn.transaction = (cb) => mockStore.transaction(cb); fn.raw = (...a) => mockStore.raw(...a); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(), isConnected: jest.fn(async () => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const gmail = require('../services/email/gmail-client');
const { isEnabled } = require('../config/feature-gates');
const P = require('../services/seo/link-authority-policy');
const M = require('../services/seo/link-outreach-mandate');
const bridge = require('../services/seo/link-authority-bridge');
const Outreach = require('../services/seo/link-prospect-outreach');
const Q = require('../services/seo/link-owner-queue');
const { makeDb, uid } = require('./helpers/link-authority-store');

const NOW = new Date('2026-09-03T07:35:00Z');
const EARLIER = new Date('2026-09-01T00:00:00Z');
const CLEAN_BODY = 'Hi Dana,\n\nWe publish a seasonal pest-pressure calendar for the Gulf Coast that your readers may find useful.\n\nAdam, Waves Pest Control';
const policyRow = (over = {}) => ({ id: 1, ...P.normalizePolicyRow(null), updated_at: EARLIER, ...over });
const domainRow = (over = {}) => ({ id: uid(), domain: 'example.org', source: 'competitor_gap', agent_state: 'qualified', score: 75, spam_score: 2, best_path_id: null, rejected_by: null, updated_at: EARLIER, ...over });
const outreachPath = (domain, over = {}) => ({
  id: uid(), domain_id: domain.id, acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null,
  estimated_cost_cents: null, renewal_cost_cents: null, renewal_period: null, currency: 'unknown', fee_scope: null, merchant_binding: null,
  account_required: false, email_verification: false, payment_required: false, legal_attestation: false, legal_terms_hash: null,
  agent_completable: true, terms_accepted_by_send: false, execution_after_send: true, baseline: false, confidence: '0.80',
  expected_rel: 'dofollow', revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
  last_investigated_at: EARLIER, superseded_by: null, authority_last_decided: null, investigation: null, updated_at: EARLIER, ...over,
});
const draftedRow = (d, p, over = {}) => ({ id: uid(), domain_id: d.id, path_id: p.id, leased_path_revision: 1, target_domain: 'example.org', target_page: '/', location_key: '-', status: 'prospect', outreach_status: 'drafted', outreach_to_email: 'editor@example.org', outreach_subject: 'A resource for your readers', outreach_body: CLEAN_BODY, outreach_sent_at: null, link_type: 'resource', notes: null, updated_at: EARLIER, ...over });
// the owner's first working values (plan §6.2): auto-outreach on above score 60, five a day
const AUTO_POLICY = { auto_outreach_min_score: 60, auto_outreach_daily_cap: 5 };

function scenario({ policy = {}, path = {}, placement = {}, contacts = {} } = {}) {
  const d = domainRow();
  const p = outreachPath(d, path);
  d.best_path_id = p.id;
  const row = draftedRow(d, p, placement);
  const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow(policy)], seo_link_prospects: [row], customers: [], notification_prefs: [], leads: [], ...contacts });
  mockStore = db;
  return { db, d, p, row };
}
const nightly = (db, opts = {}) => bridge.runAuthorityBridge(db, { now: NOW, exclusive: (k, fn) => fn(), notify: jest.fn(), autoSend: false, ...opts });
const commRow = (db) => db._tables.seo_link_placement_authorities.find((r) => r.dimension === 'communication' && !r.ended_at);
const placement = (db) => db._tables.seo_link_prospects[0];
const approvals = (db) => db._tables.seo_link_approvals;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINK_OUTREACH_DAILY_CAP;
  isEnabled.mockImplementation(() => true);
  gmail.isConnected.mockResolvedValue(true);
  gmail.sendMessage.mockResolvedValue({ id: 'msg1', threadId: 'thr1' });
});

describe('the decision on the draft (§6.3 2c)', () => {
  test('a clean draft under the policy ⇒ AUTO_OUTREACH, no park; an unclean one ⇒ OWNER_OUTREACH, parked for the click', async () => {
    const auto = scenario({ policy: AUTO_POLICY });
    await nightly(auto.db);
    expect(commRow(auto.db)).toMatchObject({ level: 'AUTO_OUTREACH' });
    expect(placement(auto.db).status).toBe('prospect');
    const owner = scenario({ policy: AUTO_POLICY, placement: { outreach_body: `${CLEAN_BODY}\nWe would gladly link back to you.` } });
    await nightly(owner.db);
    expect(commRow(owner.db)).toMatchObject({ level: 'OWNER_OUTREACH', reason: 'no lint-clean draft yet' });
    expect(placement(owner.db).status).toBe('awaiting_owner');
  });
  test('without the policy (the shipped defaults) even a clean draft is the owner\'s', async () => {
    const s = scenario();
    await nightly(s.db);
    expect(commRow(s.db).level).toBe('OWNER_OUTREACH');
  });
  test('an edit that dirties a clean draft re-decides AUTO → OWNER on the next run', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    Object.assign(placement(s.db), { outreach_body: 'We can pay a fee for the mention.', updated_at: new Date(NOW.getTime() + 1000) });
    await nightly(s.db, { now: new Date(NOW.getTime() + 60000) });
    expect(commRow(s.db).level).toBe('OWNER_OUTREACH');
  });
});

describe('sendOutreach under the contract', () => {
  test('AUTO_OUTREACH: an automatic send goes out, satisfies the instance, writes no approval', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'auto-outreach', mode: 'auto' });
    expect(r).toMatchObject({ ok: true, message_id: 'msg1', authority: { level: 'AUTO_OUTREACH', approval_id: null } });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', outreach_thread_ref: 'thr1' });
    expect(commRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
    expect(commRow(s.db).satisfied_at).toBeTruthy();
    expect(approvals(s.db)).toHaveLength(0);
  });
  test('AUTO_OUTREACH stamped, draft edited before the send claims it: an unclean draft is refused automatically (the owner may still send it)', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    expect(commRow(s.db).level).toBe('AUTO_OUTREACH');
    Object.assign(placement(s.db), { outreach_body: `${CLEAN_BODY}\nWe can pay a placement fee.` });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/no longer clean/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).outreach_status).toBe('drafted');
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' });
    expect(r).toMatchObject({ ok: true, authority: { level: 'AUTO_OUTREACH', approval_id: null } });
  });
  test('the policy cap bounds an automatic send inside the claim: cap 0 ⇒ not_authorized, cap reached ⇒ rate_limited; the owner keeps the hard cap only', async () => {
    const zero = scenario({ policy: { auto_outreach_min_score: 60, auto_outreach_daily_cap: 0 } });
    await nightly(zero.db);
    // the decision itself is OWNER_OUTREACH at cap 0 (parked) — stamp AUTO on an unparked row by hand to prove the SENDER refuses on the policy alone
    commRow(zero.db).level = 'AUTO_OUTREACH';
    Object.assign(placement(zero.db), { status: 'prospect', parked_from_status: null });
    expect(await Outreach.sendOutreach({ prospectId: zero.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/auto_outreach_daily_cap/) });
    const one = scenario({ policy: { auto_outreach_min_score: 60, auto_outreach_daily_cap: 1 } });
    await nightly(one.db);
    one.db._tables.seo_link_prospects.push(draftedRow(one.d, one.p, { id: uid(), location_key: 'x', outreach_status: 'sent', outreach_attempted_at: new Date(NOW.getTime() - 3600 * 1000) }));
    expect(await Outreach.sendOutreach({ prospectId: one.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    // the owner's click: the policy cap (1, reached) does not apply; the hard cap (12) is not reached
    commRow(one.db).level = 'OWNER_OUTREACH';
    const r = await Outreach.sendOutreach({ prospectId: one.row.id, approvedBy: 'Adam', mode: 'owner' });
    expect(r.ok).toBe(true);
  });
  test('OWNER_OUTREACH: the owner\'s click IS the approval — written under the lock, bound to the draft hash and the recipient review, consumed by the send', async () => {
    const s = scenario();
    await nightly(s.db);
    // parked for the owner: an automatic send never acts on the parked row; an unparked OWNER row refuses on the level
    expect(placement(s.db).status).toBe('awaiting_owner');
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_actionable' });
    Object.assign(placement(s.db), { status: 'prospect' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/owner's click/) });
    Object.assign(placement(s.db), { status: 'awaiting_owner' });
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' });
    expect(r.ok).toBe(true);
    const [a] = approvals(s.db);
    expect(a).toMatchObject({ dimension: 'communication', action: 'outreach_send', authority: 'OWNER_OUTREACH', money_action: false, approved_by: 'Adam', action_hash: M.draftHash(s.row), instance_key: '-:1', path_id: s.p.id });
    expect(a.terms_snapshot).toMatchObject({ draft_hash: M.draftHash(s.row), recipient_review: { match_kind: 'clear', recipient: 'editor@example.org' } });
    expect(a.consumed_at).toBeTruthy();
    expect(commRow(s.db)).toMatchObject({ approval_id: a.id, satisfied_reason: 'sent' });
    expect(r.authority).toEqual({ level: 'OWNER_OUTREACH', approval_id: a.id });
    // the released placement reads contacted; a second click is already_sent
    expect(placement(s.db).status).toBe('contacted');
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'already_sent' });
  });
  test('a live approval bound to THIS draft is reused; one bound to an earlier text is spent by the edit and replaced', async () => {
    const s = scenario();
    await nightly(s.db);
    const prior = { id: uid(), prospect_id: s.row.id, path_id: s.p.id, path_revision: 1, decision_inputs_hash: commRow(s.db).decision_inputs_hash, money_action: false, decision: 'approved', authority: 'OWNER_OUTREACH', terms_snapshot: {}, dimension: 'communication', action: 'outreach_send', instance_key: '-:1', action_hash: M.draftHash(s.row), approved_by: 'Adam', approved_at: EARLIER, invalidated_at: null, consumed_at: null };
    approvals(s.db).push(prior);
    commRow(s.db).approval_id = prior.id;
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' });
    expect(r).toMatchObject({ ok: true, authority: { approval_id: prior.id } });
    expect(approvals(s.db)).toHaveLength(1);
    // edited after the approval: the old approval is spent, the click writes a fresh one for the new text
    const t = scenario();
    await nightly(t.db);
    const stale = { ...prior, id: uid(), prospect_id: t.row.id, path_id: t.p.id, decision_inputs_hash: commRow(t.db).decision_inputs_hash, action_hash: 'x'.repeat(64), invalidated_at: null, consumed_at: null };
    approvals(t.db).push(stale);
    commRow(t.db).approval_id = stale.id;
    const r2 = await Outreach.sendOutreach({ prospectId: t.row.id, approvedBy: 'Adam' });
    expect(r2.ok).toBe(true);
    expect(approvals(t.db).find((a) => a.id === stale.id)).toMatchObject({ invalidated_reason: 'draft changed after the approval' });
    expect(approvals(t.db)).toHaveLength(2);
    expect(commRow(t.db).approval_id).not.toBe(stale.id);
  });
  test('refusals: no row yet, a prior-path row, a stale decision, a non-owner level, a terms-accepting send', async () => {
    const none = scenario();
    expect(await Outreach.sendOutreach({ prospectId: none.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/decides it first/) });
    const prior = scenario();
    await nightly(prior.db);
    commRow(prior.db).path_id = uid();
    expect(await Outreach.sendOutreach({ prospectId: prior.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/prior path/) });
    const stale = scenario();
    await nightly(stale.db);
    commRow(stale.db).decision_inputs_hash = 'f'.repeat(64);
    expect(await Outreach.sendOutreach({ prospectId: stale.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/inputs changed/) });
    const deny = scenario();
    await nightly(deny.db);
    commRow(deny.db).level = 'DENY';
    expect(await Outreach.sendOutreach({ prospectId: deny.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/DENY/) });
    const terms = scenario({ path: { terms_accepted_by_send: true, legal_attestation: true, legal_terms_hash: 'a'.repeat(64), investigation: { legal_terms_url: 'https://example.org/terms' } } });
    await nightly(terms.db);
    expect(await Outreach.sendOutreach({ prospectId: terms.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/accepts the publisher/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    for (const s of [none, prior, stale, deny, terms]) expect(approvals(s.db)).toHaveLength(0);
  });
  test('GATE_LINK_AUTHORITY off: the shipped owner click stands alone (no rows, no approval); an automatic send is refused', async () => {
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    const s = scenario();
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' });
    expect(r).toMatchObject({ ok: true, authority: null });
    expect(approvals(s.db)).toHaveLength(0);
  });
});

describe('the customer exclusion inside the claim (§13)', () => {
  test('an identified customer recipient is a hard block for every mode — nothing is claimed, no approval is written', async () => {
    const s = scenario({ contacts: { customers: [{ id: 'c1', email: 'editor@example.org', service_contact_email: null, service_contact2_email: null, service_contact3_email: null }] } });
    await nightly(s.db);
    Object.assign(placement(s.db), { status: 'prospect', parked_from_status: null }); // unparked, so the automatic mode reaches the review too
    for (const mode of ['owner', 'auto']) {
      const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode, reviewedLookupHash: 'anything' });
      expect(r).toMatchObject({ ok: false, code: 'customer_recipient', review: { kind: 'customer', matched: [{ source: 'customers.email', id: 'c1' }] } });
    }
    expect(placement(s.db).outreach_status).toBe('drafted');
    expect(approvals(s.db)).toHaveLength(0);
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
  test('a shared business domain: never automatic; the owner sends only with the SAME lookup hash acknowledged, and the approval binds it', async () => {
    const s = scenario({ contacts: { customers: [{ id: 'c2', email: 'ads@example.org' }] } });
    await nightly(s.db);
    Object.assign(placement(s.db), { status: 'prospect', parked_from_status: null });
    commRow(s.db).level = 'AUTO_OUTREACH';
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'recipient_review_required', review: { kind: 'ambiguous' } });
    commRow(s.db).level = 'OWNER_OUTREACH';
    const first = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' });
    expect(first).toMatchObject({ ok: false, code: 'recipient_review_required' });
    const wrong = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', reviewedLookupHash: 'stale-hash' });
    expect(wrong.code).toBe('recipient_review_required');
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', reviewedLookupHash: first.review.lookup_hash });
    expect(r.ok).toBe(true);
    expect(approvals(s.db)[0].terms_snapshot.recipient_review).toMatchObject({ match_kind: 'ambiguous', lookup_hash: first.review.lookup_hash, matched_ids: [{ source: 'customers.email', id: 'c2' }] });
  });
  test('a lookup failure fails closed', async () => {
    const s = scenario();
    await nightly(s.db);
    s.db._beforeResolve = (table) => { if (table === 'leads') throw new Error('timeout'); };
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'recipient_lookup_failed' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).outreach_status).toBe('drafted');
  });
});

describe('reconcileSendError', () => {
  test("'sent' satisfies the open communication instance and consumes its approval", async () => {
    const s = scenario();
    await nightly(s.db);
    const a = { id: uid(), prospect_id: s.row.id, path_id: s.p.id, path_revision: 1, decision_inputs_hash: commRow(s.db).decision_inputs_hash, money_action: false, decision: 'approved', authority: 'OWNER_OUTREACH', terms_snapshot: {}, dimension: 'communication', action: 'outreach_send', instance_key: '-:1', action_hash: M.draftHash(s.row), approved_by: 'Adam', approved_at: EARLIER, invalidated_at: null, consumed_at: null };
    approvals(s.db).push(a);
    commRow(s.db).approval_id = a.id;
    Object.assign(placement(s.db), { outreach_status: 'send_error', outreach_send_token: null });
    const r = await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' });
    expect(r.ok).toBe(true);
    expect(commRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
    expect(a.consumed_at).toBeTruthy();
  });
});

describe('the nightly auto-send (§6.4)', () => {
  test('a nightly run hands its AUTO_OUTREACH drafted placements to the sender in auto mode; the sender\'s cap ends the batch', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    const send = jest.fn(async () => ({ ok: true }));
    const r = await nightly(s.db, { autoSend: true, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'auto', approvedBy: 'auto-outreach' }));
    expect(r.autoSend).toEqual({ attempted: 1, sent: 1, skipped: [] });
    // a second domain: the first send hits the cap ⇒ the second is not attempted
    const t = scenario({ policy: AUTO_POLICY });
    const d2 = domainRow({ domain: 'second.org' }); const p2 = outreachPath(d2); d2.best_path_id = p2.id;
    t.db._tables.seo_link_domains.push(d2); t.db._tables.seo_link_acquisition_paths.push(p2);
    t.db._tables.seo_link_prospects.push(draftedRow(d2, p2, { target_domain: 'second.org', outreach_to_email: 'editor@second.org' }));
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    const r2 = await nightly(t.db, { autoSend: true, send: capped });
    expect(capped).toHaveBeenCalledTimes(1);
    expect(r2.autoSend).toMatchObject({ attempted: 1, sent: 0, skipped: [{ code: 'rate_limited' }] });
  });
  test('an OWNER_OUTREACH placement, an undrafted one and a leased one are never auto-sent; an inline click run (autoSend false) sends nothing; the outreach gate off sends nothing', async () => {
    const owner = scenario({ placement: { outreach_body: 'we will link back' }, policy: AUTO_POLICY });
    const send = jest.fn(async () => ({ ok: true }));
    expect((await nightly(owner.db, { autoSend: true, send })).autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
    const leased = scenario({ policy: AUTO_POLICY, placement: { claimed_at: NOW } });
    expect((await nightly(leased.db, { autoSend: true, send })).autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
    const inline = scenario({ policy: AUTO_POLICY });
    await nightly(inline.db, { autoSend: false, send });
    expect(send).not.toHaveBeenCalled();
    // the default is OFF: an admin's manual job (no autoSend option) never sends — only the scheduler opts in
    const manual = scenario({ policy: AUTO_POLICY });
    expect((await bridge.runAuthorityBridge(manual.db, { now: NOW, exclusive: (k, fn) => fn(), notify: jest.fn(), send })).autoSend).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    isEnabled.mockImplementation((g) => g !== 'linkProspectOutreach');
    const gated = scenario({ policy: AUTO_POLICY });
    expect((await nightly(gated.db, { autoSend: true, send })).autoSend).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  test('the real sender over the store: the run sends, the placement reads contacted and the instance is satisfied', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    const r = await nightly(s.db, { autoSend: true, send: (args) => Outreach.sendOutreach(args) });
    expect(r.autoSend).toEqual({ attempted: 1, sent: 1, skipped: [] });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent' });
    expect(commRow(s.db).satisfied_reason).toBe('sent');
  });
});

describe('the Owner queue Send action', () => {
  test('the card offers Send on a drafted OWNER_OUTREACH row; sendRow routes to the sender as the owner with the acknowledged hash', async () => {
    const s = scenario();
    await nightly(s.db);
    const { cards } = await Q.listOwnerQueue(s.db);
    const row = cards[0].rows.find((r) => r.dimension === 'communication');
    expect(row).toMatchObject({ approvable: true, action: 'outreach_send', draft: { to: 'editor@example.org', subject: 'A resource for your readers', review: { clean: true }, recipient_review: { kind: 'clear' } } });
    const send = jest.fn(async () => ({ ok: true, message_id: 'm', thread_id: 't', authority: { level: 'OWNER_OUTREACH', approval_id: 'a' } }));
    const r = await Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', reviewedLookupHash: 'h', send });
    expect(send).toHaveBeenCalledWith({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', reviewedLookupHash: 'h' });
    expect(r).toMatchObject({ sent: true, prospectId: s.row.id, message_id: 'm' });
  });
  test('sendRow refuses: no actor, an unknown row, a non-communication row, a leased or released placement; a sender refusal maps to its status with the review attached', async () => {
    const s = scenario();
    await nightly(s.db);
    const row = commRow(s.db);
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: null })).rejects.toMatchObject({ status: 400 });
    await expect(Q.sendRow(s.db, { authorityId: uid(), actor: 'Adam' })).rejects.toMatchObject({ status: 404 });
    s.db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: s.row.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE' });
    await expect(Q.sendRow(s.db, { authorityId: s.db._tables.seo_link_placement_authorities[1].id, actor: 'Adam' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/initial send/) });
    placement(s.db).claimed_at = NOW;
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/leased/) });
    placement(s.db).claimed_at = null;
    const refused = jest.fn(async () => ({ ok: false, code: 'recipient_review_required', error: 'review it', review: { kind: 'ambiguous', lookup_hash: 'h9' } }));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', send: refused })).rejects.toMatchObject({ status: 409, code: 'recipient_review_required', review: { lookup_hash: 'h9' }, message: 'review it' });
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', send: capped })).rejects.toMatchObject({ status: 429 });
  });
  test('the card withholds Send for a customer recipient and for a row whose draft was cleared; Approve on a communication row is refused', async () => {
    const s = scenario({ contacts: { customers: [{ id: 'c1', email: 'editor@example.org' }] } });
    await nightly(s.db);
    const row = (await Q.listOwnerQueue(s.db)).cards[0].rows.find((r) => r.dimension === 'communication');
    expect(row).toMatchObject({ approvable: false, why_not: expect.stringMatching(/customer contact/) });
    await expect(Q.approveRow(s.db, { authorityId: row.id, actor: 'Adam', now: NOW, bridge: (db, o) => bridge.runAuthorityBridge(db, { ...o, exclusive: (k, fn) => fn() }) })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Send action/) });
    const t = scenario();
    await nightly(t.db);
    Object.assign(placement(t.db), { outreach_status: 'none', outreach_body: null });
    const cleared = (await Q.listOwnerQueue(t.db)).cards[0].rows.find((r) => r.dimension === 'communication');
    expect(cleared).toMatchObject({ approvable: false, why_not: expect.stringMatching(/no draft to send/) });
  });
});
