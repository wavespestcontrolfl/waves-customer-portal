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
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(), isConnected: jest.fn(async () => true), getThread: jest.fn(), ownAddress: () => 'contact@wavespestcontrol.com' }));
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
const storedPath = (db) => db._tables.seo_link_acquisition_paths[0];

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
  test('a lifecycle the admin advanced while Gmail was being called stays: the finalize lands the send stamp on it and satisfies the instance, never overwriting it with contacted', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    gmail.sendMessage.mockImplementationOnce(async () => { placement(s.db).status = 'watching'; return { id: 'msg1', threadId: 'thr1' }; }); // moved on mid-send
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'auto-outreach', mode: 'auto' })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'watching', outreach_status: 'sent', outreach_thread_ref: 'thr1', outreach_send_token: null });
    expect(commRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
  });
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
    // the owner's click on the AUTO row sends nothing either: no approval can bind an edited draft to an AUTO level
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/no longer clean/) });
    // the next nightly re-decides it OWNER_OUTREACH; the click then writes the approval for the new text
    Object.assign(placement(s.db), { updated_at: new Date(NOW.getTime() + 1000) });
    await nightly(s.db, { now: new Date(NOW.getTime() + 60000) });
    expect(commRow(s.db).level).toBe('OWNER_OUTREACH');
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' });
    expect(r).toMatchObject({ ok: true, authority: { level: 'OWNER_OUTREACH' } });
    expect(approvals(s.db)[0].action_hash).toBe(M.draftHash(placement(s.db)));
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
    one.db._tables.seo_link_prospects.push(draftedRow(one.d, one.p, { id: uid(), location_key: 'x', outreach_to_email: 'other@elsewhere.org', outreach_status: 'sent', outreach_attempted_at: new Date(NOW.getTime() - 3600 * 1000) }));
    expect(await Outreach.sendOutreach({ prospectId: one.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    // the owner's click: the policy cap (1, reached) does not apply; the hard cap (12) is not reached
    commRow(one.db).level = 'OWNER_OUTREACH';
    const r = await Outreach.sendOutreach({ prospectId: one.row.id, approvedBy: 'Adam', mode: 'owner' });
    expect(r.ok).toBe(true);
  });
  test('OWNER_OUTREACH: the owner\'s click IS the approval — written under the lock, bound to the draft hash and the recipient review, consumed by the send', async () => {
    const s = scenario({ policy: { auto_outreach_min_score: 99, auto_outreach_daily_cap: 5 } }); // the policy is on but the score is below its floor ⇒ OWNER_OUTREACH
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
  test('a capped click writes no approval; a claim lost after the approval rolls it back', async () => {
    process.env.LINK_OUTREACH_DAILY_CAP = '1';
    const s = scenario();
    await nightly(s.db);
    s.db._tables.seo_link_prospects.push(draftedRow(s.d, s.p, { id: uid(), location_key: 'x', outreach_to_email: 'other@elsewhere.org', outreach_status: 'sent', outreach_attempted_at: new Date(NOW.getTime() - 3600 * 1000) }));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(approvals(s.db)).toHaveLength(0);
    delete process.env.LINK_OUTREACH_DAILY_CAP;
    // the CAS misses (the row's outreach_status moved under the lock): the approval written by the click is rolled back
    const t = scenario();
    await nightly(t.db);
    t.db._beforeUpdate = (table, db) => { if (table === 'seo_link_prospects' && db._tables.seo_link_approvals.length) { placement(db).outreach_status = 'sending'; db._beforeUpdate = null; } };
    let rolled = false;
    const realTx = t.db.transaction;
    t.db.transaction = async (cb) => { try { return await cb(t.db); } catch (err) { if (err && err.result) { rolled = true; t.db._tables.seo_link_approvals.length = 0; } throw err; } };
    expect(await Outreach.sendOutreach({ prospectId: t.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'already_sent' });
    expect(rolled).toBe(true);
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    t.db.transaction = realTx;
  });
  test('a live approval bound to THIS draft is reused; one bound to an earlier text is spent by the edit and replaced', async () => {
    const s = scenario();
    await nightly(s.db);
    const clearHash = (await M.recipientReview(s.db, s.row.outreach_to_email)).lookup_hash;
    const prior = { id: uid(), prospect_id: s.row.id, path_id: s.p.id, path_revision: 1, decision_inputs_hash: commRow(s.db).decision_inputs_hash, money_action: false, decision: 'approved', authority: 'OWNER_OUTREACH', terms_snapshot: { recipient_review: { lookup_hash: clearHash } }, dimension: 'communication', action: 'outreach_send', instance_key: '-:1', action_hash: M.draftHash(s.row), approved_by: 'Adam', approved_at: EARLIER, invalidated_at: null, consumed_at: null };
    approvals(s.db).push(prior);
    commRow(s.db).approval_id = prior.id;
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' });
    expect(r).toMatchObject({ ok: true, authority: { approval_id: prior.id } });
    expect(approvals(s.db)).toHaveLength(1);
    // the same text, but the recipient review changed since (a customer's domain appeared): the old approval is spent
    const u = scenario({ contacts: { customers: [{ id: 'c9', email: 'ads@example.org' }] } });
    await nightly(u.db);
    const old = { ...prior, id: uid(), prospect_id: u.row.id, path_id: u.p.id, decision_inputs_hash: commRow(u.db).decision_inputs_hash, action_hash: M.draftHash(u.row), terms_snapshot: { recipient_review: { lookup_hash: clearHash } }, invalidated_at: null, consumed_at: null };
    approvals(u.db).push(old);
    commRow(u.db).approval_id = old.id;
    const refused = await Outreach.sendOutreach({ prospectId: u.row.id, approvedBy: 'Adam' });
    expect(refused.code).toBe('recipient_review_required');
    const r3 = await Outreach.sendOutreach({ prospectId: u.row.id, approvedBy: 'Adam', reviewedLookupHash: refused.review.lookup_hash });
    expect(r3.ok).toBe(true);
    expect(approvals(u.db).find((a) => a.id === old.id)).toMatchObject({ invalidated_reason: 'recipient review changed after the approval' });
    expect(approvals(u.db)).toHaveLength(2);
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
  test('refusals: a rejected / watched domain, and a placement no longer on the domain\'s best path', async () => {
    const rej = scenario();
    await nightly(rej.db);
    rej.db._tables.seo_link_domains[0].agent_state = 'rejected';
    expect(await Outreach.sendOutreach({ prospectId: rej.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/rejected/) });
    rej.db._tables.seo_link_domains[0].agent_state = 'watching';
    expect((await Outreach.sendOutreach({ prospectId: rej.row.id, approvedBy: 'Adam' })).error).toMatch(/watching/);
    const rerank = scenario();
    await nightly(rerank.db);
    const other = outreachPath(rerank.d); rerank.db._tables.seo_link_acquisition_paths.push(other); rerank.db._tables.seo_link_domains[0].best_path_id = other.id;
    expect(await Outreach.sendOutreach({ prospectId: rerank.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/best path/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(approvals(rej.db)).toHaveLength(0); expect(approvals(rerank.db)).toHaveLength(0);
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
  test('a send that accepts the publisher\'s terms is refused BEFORE any level grants — an AUTO_OUTREACH row in auto mode included', async () => {
    const s = scenario({ policy: AUTO_POLICY, path: { terms_accepted_by_send: true, legal_attestation: true, legal_attestation_requires_owner: false, legal_terms_hash: 'a'.repeat(64), investigation: { legal_terms_url: 'https://example.org/terms' } } });
    await nightly(s.db);
    commRow(s.db).level = 'AUTO_OUTREACH'; // whatever the nightly decided, the automatic grant must not reach Gmail
    Object.assign(placement(s.db), { status: 'prospect', parked_from_status: null }); // unparked, so auto mode reaches the authority
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/accepts the publisher/) });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/accepts the publisher/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).outreach_status).toBe('drafted');
    expect(approvals(s.db)).toHaveLength(0);
  });
  test('an AUTO_OUTREACH stamp is honoured only while the CURRENT policy grants it: a raised score floor (outside the hash) refuses the send until the nightly re-decides', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    expect(commRow(s.db).level).toBe('AUTO_OUTREACH');
    // the owner tightens the mandate; the domain (score 75) no longer clears it, the decision hash (floors only) is unchanged
    s.db._tables.seo_link_policy[0].auto_outreach_min_score = 90;
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/policy moved/) });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/policy moved/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).outreach_status).toBe('drafted');
    expect(approvals(s.db)).toHaveLength(0);
    // loosened again: the stamp stands
    s.db._tables.seo_link_policy[0].auto_outreach_min_score = 60;
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).ok).toBe(true);
  });
  test('another open owner decision on the placement holds the send (the park would clear with it undecided); a payment deferred past the send does not', async () => {
    // a price the owner must ENTER parks at once (OWNER_INPUT_REQUIRED is not deferrable) — the pitch waits for it
    const held = scenario({ path: { payment_required: true, fee_scope: 'per_location', estimated_cost_cents: null, currency: 'unknown' } });
    await nightly(held.db);
    expect(placement(held.db).status).toBe('awaiting_owner');
    expect(await Outreach.sendOutreach({ prospectId: held.row.id, approvedBy: 'Adam', mode: 'owner' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/payment: OWNER_INPUT_REQUIRED/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(held.db)).toMatchObject({ status: 'awaiting_owner', outreach_status: 'drafted' });
    expect(approvals(held.db)).toHaveLength(0);
    // a checkout the owner settles AFTER the pitch (OWNER_MANUAL_PAYMENT, deferred) is no hold
    const deferred = scenario({ path: { payment_required: true, fee_scope: 'per_location', estimated_cost_cents: 4500, currency: 'USD', merchant_binding: null } });
    await nightly(deferred.db);
    expect((await Outreach.sendOutreach({ prospectId: deferred.row.id, approvedBy: 'Adam', mode: 'owner' })).ok).toBe(true);
    expect(placement(deferred.db).status).toBe('contacted');
  });
  test('an OWNER_LEGAL send: held until the agreement is accepted; its approval then carries the agreement URL the owner read (as the queue\'s Approve records it)', async () => {
    const s = scenario({ path: { legal_attestation: true, legal_terms_hash: 'a'.repeat(64), investigation: { legal_terms_url: 'https://example.org/terms' } } });
    await nightly(s.db);
    expect(commRow(s.db).level).toBe('OWNER_LEGAL');
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/execution: OWNER_LEGAL/) });
    // the terms instance accepted (the queue's accept_terms approval satisfies it) — nothing else holds the placement
    const terms = s.db._tables.seo_link_placement_authorities.find((r) => r.dimension === 'execution' && r.instance_kind === 'terms' && !r.ended_at);
    Object.assign(terms, { satisfied_at: NOW, satisfied_reason: 'accepted' });
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner' })).ok).toBe(true);
    expect(approvals(s.db)[0]).toMatchObject({ authority: 'OWNER_LEGAL', action: 'outreach_send', terms_snapshot: expect.objectContaining({ legal_terms_url: 'https://example.org/terms', draft_hash: M.draftHash(s.row) }) });
  });
  test('the cap window is the ET calendar day: last night\'s attempts (inside a trailing 24h) do not hold this night\'s run; today\'s do', async () => {
    const s = scenario({ policy: { auto_outreach_min_score: 60, auto_outreach_daily_cap: 1 } });
    await nightly(s.db);
    // an attempt 23h before this 3:35 ET run — yesterday's calendar day
    const yesterday = new Date(NOW.getTime() - 23 * 3600 * 1000);
    s.db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'old.org', status: 'contacted', outreach_status: 'sent', outreach_to_email: 'x@old.org', outreach_attempted_at: yesterday, outreach_sent_at: yesterday });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', now: NOW })).toMatchObject({ ok: true });
    // one stamped after this ET midnight counts: cap 1 is reached
    const t = scenario({ policy: { auto_outreach_min_score: 60, auto_outreach_daily_cap: 1 } });
    await nightly(t.db);
    const today = new Date(NOW.getTime() - 3 * 3600 * 1000); // 00:35 ET
    t.db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'old.org', status: 'contacted', outreach_status: 'sent', outreach_to_email: 'x@old.org', outreach_attempted_at: today, outreach_sent_at: today });
    expect(await Outreach.sendOutreach({ prospectId: t.row.id, mode: 'auto', now: NOW })).toMatchObject({ ok: false, code: 'rate_limited' });
  });
  test('a reopened row still carrying its closure stamp: the claim drops it, so the in-flight conversation holds its inbox', async () => {
    const s = scenario({ policy: AUTO_POLICY, placement: { conversation_closed_at: EARLIER } });
    await nightly(s.db);
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', conversation_closed_at: null });
  });
  test('an attested path whose agreement is not viewable (no terms url in the evidence) sends nothing — the board\'s direct send refuses like the queue\'s Approve', async () => {
    const s = scenario({ path: { legal_attestation: true, legal_terms_hash: 'a'.repeat(64) } });
    await nightly(s.db);
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/not viewable/) });
    expect(approvals(s.db)).toHaveLength(0);
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
  test('GATE_LINK_AUTHORITY off: the shipped owner click stands alone (no rows, no approval); an automatic send is refused', async () => {
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    const s = scenario();
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' });
    expect(r).toMatchObject({ ok: true, authority: null });
    expect(approvals(s.db)).toHaveLength(0);
    // a placement the bridge PARKED keeps its open decisions: the gate-off click never clears that park unchecked
    const parked = scenario({ placement: { status: 'awaiting_owner', parked_from_status: 'prospect' } });
    expect(await Outreach.sendOutreach({ prospectId: parked.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/parked by the authority bridge/) });
    expect(placement(parked.db)).toMatchObject({ status: 'awaiting_owner', outreach_status: 'drafted' });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
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

describe('one conversation per inbox (§13)', () => {
  test('a second placement addressed to a recipient whose conversation is open is refused in every mode; a dormant sibling is not', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    const other = { id: uid(), domain_id: null, path_id: null, target_domain: 'other.org', target_page: '/', location_key: '-', status: 'contacted', outreach_status: 'sent', outreach_to_email: 'Editor@Example.org ', outreach_sent_at: EARLIER, link_type: 'editorial', updated_at: EARLIER };
    s.db._tables.seo_link_prospects.push(other);
    for (const mode of ['auto', 'owner']) expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode })).toMatchObject({ ok: false, code: 'inbox_in_flight' });
    // an ambiguous send elsewhere (send_error) and a parked follow-up conversation hold the inbox too
    Object.assign(other, { status: 'prospect', outreach_status: 'send_error', outreach_sent_at: null });
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).code).toBe('inbox_in_flight');
    Object.assign(other, { status: 'awaiting_owner', parked_from_status: 'contacted', outreach_status: 'none' });
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).code).toBe('inbox_in_flight');
    // a dormant row to the same inbox (prospect, no send) does not
    Object.assign(other, { status: 'prospect', parked_from_status: null, outreach_status: 'none' });
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).ok).toBe(true);
    // the claim's lock order: the cap lock, the placement's DOMAIN (the registry's per-domain writer lock — Reject /
    // Watch / a re-rank serialize on it), the recipient's inbox, then the row locks — the manual status edit's order too
    const all = s.db._raws.map(String);
    const raws = all.slice(all.lastIndexOf('SELECT pg_advisory_xact_lock(?) [778932]')); // the last claim (the one that sent)
    const at = (re) => raws.findIndex((r) => re.test(r));
    expect(raws.length).toBeGreaterThan(1);
    expect(at(/lost_recovery:example\.org/)).toBeGreaterThan(0);
    expect(at(/link_outreach_inbox:editor@example\.org/)).toBeGreaterThan(at(/lost_recovery:example\.org/));
    expect(at(/FOR UPDATE seo_link_prospects/)).toBeGreaterThan(at(/link_outreach_inbox:editor@example\.org/));
    expect(at(/FOR UPDATE seo_link_policy/)).toBeGreaterThan(at(/FOR UPDATE seo_link_prospects/)); // the policy the claim decides under is locked with it
  });
  test('a CLOSED conversation releases the inbox: a completed placement (placed / live / indexed / watching / lost / rejected) or one carrying the closure stamp; an active one with its pitch out holds it until then', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    // the earlier placement pitched this inbox — its lifetime send stamp never holds the inbox on its own
    const other = { id: uid(), domain_id: null, path_id: null, target_domain: 'other.org', target_page: '/', location_key: '-', status: 'lost', outreach_status: 'sent', outreach_to_email: 'editor@example.org', outreach_sent_at: EARLIER, conversation_closed_at: null, link_type: 'editorial', updated_at: EARLIER };
    s.db._tables.seo_link_prospects.push(other);
    for (const status of ['lost', 'rejected', 'placed', 'live', 'indexed', 'watching']) {
      Object.assign(other, { status });
      expect(await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org' })).toBeNull();
    }
    // … unless the send is still AMBIGUOUS (in flight / errored before the Sent-folder reconcile): Gmail may have
    // delivered it, so a status advanced by hand does not release the inbox until the reconcile settles the outcome
    for (const outreach_status of Outreach.AMBIGUOUS_SEND_STATUSES) {
      Object.assign(other, { status: 'watching', outreach_status, conversation_closed_at: NOW });
      expect((await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org' }))?.id).toBe(other.id);
    }
    Object.assign(other, { status: 'lost', outreach_status: 'sent', conversation_closed_at: null });
    expect(await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org' })).toBeNull();
    // an ACTIVE conversation (contacted, the pitch out) holds the inbox …
    Object.assign(other, { status: 'contacted' });
    expect((await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org' }))?.id).toBe(other.id);
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'inbox_in_flight' });
    // … until its communication lifecycle is stamped closed (§3.3) — whatever its status reads
    Object.assign(other, { conversation_closed_at: NOW });
    expect(await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org' })).toBeNull();
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).ok).toBe(true);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });
  test('a gmail alias of an open conversation is the same inbox', async () => {
    const s = scenario({ policy: AUTO_POLICY, placement: { outreach_to_email: 'editor@gmail.com' } });
    await nightly(s.db);
    s.db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'other.org', target_page: '/', location_key: '-', status: 'contacted', outreach_status: 'sent', outreach_to_email: 'Edi.tor+news@googlemail.com', outreach_sent_at: EARLIER, link_type: 'editorial', updated_at: EARLIER });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'inbox_in_flight' });
  });
  test('a draft re-addressed under the lock is not sent by a claim that locked another inbox', async () => {
    const s = scenario();
    await nightly(s.db);
    // the pre-read is the first prospects read; the claim's row lock (after the inbox lock) is the second — re-address there
    let reads = 0;
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects' && ++reads === 2) { placement(db).outreach_to_email = 'other@example.org'; db._beforeResolve = null; } };
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'recipient_changed' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
});

describe('inboxConflict is the guard every conversation writer takes', () => {
  test('returns the open conversation for the recipient (canonical, gmail aliases), null when the inbox is free', async () => {
    const s = scenario();
    const db = s.db;
    db._tables.seo_link_prospects.push({ id: 'o1', target_domain: 'x.org', target_page: '/', location_key: '-', status: 'contacted', outreach_status: 'sent', outreach_to_email: ' Edi.tor+a@googlemail.com', outreach_sent_at: EARLIER, link_type: 'editorial', updated_at: EARLIER });
    expect((await Outreach.inboxConflict(db, { recipient: 'editor@gmail.com' }))?.id).toBe('o1');
    expect(await Outreach.inboxConflict(db, { recipient: 'editor@gmail.com', excludeId: 'o1' })).toBeNull();
    expect(await Outreach.inboxConflict(db, { recipient: 'someone@else.org' })).toBeNull();
    expect(await Outreach.inboxConflict(db, { recipient: '' })).toBeNull();
    expect(db._raws.some((r) => /hashtext/.test(String(r)))).toBe(true);
  });
});

describe('submit-first outreach paths (execution_after_send=false)', () => {
  test('nothing sends while the execution instance is open — the nightly skips it and the sender refuses; a satisfied execution releases the pitch', async () => {
    const s = scenario({ policy: AUTO_POLICY, path: { execution_after_send: false, account_required: true } });
    const send = jest.fn(async () => ({ ok: true }));
    const r = await nightly(s.db, { autoSend: true, send });
    expect(send).not.toHaveBeenCalled();
    expect(r.autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
    Object.assign(placement(s.db), { status: 'prospect', parked_from_status: null }); // unparked, so both modes reach the ordering check
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/submit-first/) });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/submit-first/) });
    const exec = s.db._tables.seo_link_placement_authorities.find((x) => x.dimension === 'execution' && !x.ended_at);
    Object.assign(exec, { satisfied_at: NOW, satisfied_reason: 'placed' });
    // the placement is still `prospect` here (nothing can promote a submit-first row yet — PR 4); the owner's send is allowed
    Object.assign(placement(s.db), { status: 'prospect', parked_from_status: null });
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam' })).ok).toBe(true);
  });
  test('the flag orders nothing on a path with NO acquire step (no account, not a content submission): the nightly sends it and the owner may too', async () => {
    const s = scenario({ policy: AUTO_POLICY, path: { execution_after_send: false, account_required: false } });
    expect(s.db._tables.seo_link_placement_authorities.some((x) => x.dimension === 'execution')).toBe(false);
    const send = jest.fn(async () => ({ ok: true }));
    const r = await nightly(s.db, { autoSend: true, send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'auto' }));
    expect(r.autoSend).toMatchObject({ attempted: 1, sent: 1 });
    const o = scenario({ path: { execution_after_send: false, account_required: false } });
    await nightly(o.db);
    expect((await Outreach.sendOutreach({ prospectId: o.row.id, approvedBy: 'Adam' })).ok).toBe(true);
  });
});

describe('the owner resolving an ambiguous recipient on an AUTO_OUTREACH row', () => {
  test('the acknowledgement is recorded as an OWNER_OUTREACH approval bound to the draft and the match', async () => {
    const s = scenario({ policy: AUTO_POLICY, contacts: { customers: [{ id: 'c2', email: 'ads@example.org' }] } });
    await nightly(s.db);
    expect(commRow(s.db).level).toBe('AUTO_OUTREACH');
    const first = await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto' });
    expect(first).toMatchObject({ ok: false, code: 'recipient_review_required' });
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', reviewedLookupHash: first.review.lookup_hash });
    expect(r.ok).toBe(true);
    const [a] = approvals(s.db);
    expect(a).toMatchObject({ authority: 'OWNER_OUTREACH', action: 'outreach_send', approved_by: 'Adam', action_hash: M.draftHash(s.row) });
    expect(a.terms_snapshot.recipient_review).toMatchObject({ match_kind: 'ambiguous', lookup_hash: first.review.lookup_hash });
    expect(a.consumed_at).toBeTruthy();
    expect(r.authority).toEqual({ level: 'AUTO_OUTREACH', approval_id: a.id });
    expect(commRow(s.db)).toMatchObject({ approval_id: a.id, satisfied_reason: 'sent' });
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
  test("'requeue' on a row whose lifecycle moved on is refused: the draft would be listed nowhere and sent by nothing", async () => {
    const s = scenario();
    await nightly(s.db);
    Object.assign(placement(s.db), { status: 'watching', outreach_status: 'send_error', outreach_send_token: null });
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'requeue', approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_requeueable' });
    expect(placement(s.db)).toMatchObject({ status: 'watching', outreach_status: 'send_error' });
  });
  test('a lifecycle edit that lands between the reconcile\'s read and its write is never overwritten: the compare-and-swap includes the status observed', async () => {
    const s = scenario();
    await nightly(s.db);
    Object.assign(placement(s.db), { outreach_status: 'send_error', outreach_send_token: null });
    s.db._beforeUpdate = (table, db) => { if (table === 'seo_link_prospects') { placement(db).status = 'watching'; db._beforeUpdate = null; } }; // the admin moved it on meanwhile
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_reconcilable' });
    expect(placement(s.db)).toMatchObject({ status: 'watching', outreach_status: 'send_error' });
  });
  test("'sent' on a row whose lifecycle the admin already advanced by hand keeps that lifecycle (the send stamp settles, the inbox is released); a row still awaiting one opens it (→ contacted)", async () => {
    const s = scenario();
    await nightly(s.db);
    Object.assign(placement(s.db), { status: 'watching', outreach_status: 'send_error', outreach_send_token: null, outreach_to_email: 'editor@example.org' });
    expect((await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org', excludeId: 'none' }))?.id).toBe(s.row.id); // ambiguous ⇒ held
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'watching', outreach_status: 'sent' });
    expect(await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org', excludeId: 'none' })).toBeNull(); // settled ⇒ released
    const t = scenario();
    await nightly(t.db);
    Object.assign(placement(t.db), { outreach_status: 'send_error', outreach_send_token: null });
    expect((await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(placement(t.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent' });
  });
  test("'sent' satisfies the instance when only another dimension was revised earlier (overall revision ≠ communication revision)", async () => {
    // the path's payment inputs were revised before the draft: overall revision 3, communication revision 1; the draft is stamped 3
    const s = scenario({ path: { revision: 3, revision_payment: 3, revision_communication: 1 }, placement: { leased_path_revision: 3 } });
    await nightly(s.db);
    expect(commRow(s.db).path_revision).toBe(1);
    Object.assign(placement(s.db), { outreach_status: 'send_error', outreach_send_token: null });
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(commRow(s.db).satisfied_reason).toBe('sent');
  });
  test("'sent' never satisfies a later generation: the open instance must sit on the path revision the send was bound to", async () => {
    const s = scenario();
    await nightly(s.db);
    // the path was revised in place after the ambiguous send (the draft's stamp is revision 1; the path now reads revision 2)
    Object.assign(storedPath(s.db), { revision: 2, revision_communication: 2 });
    commRow(s.db).path_revision = 2;
    Object.assign(placement(s.db), { outreach_status: 'send_error', outreach_send_token: null });
    const r = await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' });
    expect(r.ok).toBe(true);
    expect(placement(s.db).status).toBe('contacted');
    expect(commRow(s.db).satisfied_at).toBeFalsy();
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
  test('a draft the cap deferred is attempted again on the next nightly even though its domain is not re-selected', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    expect((await nightly(s.db, { autoSend: true, send: capped })).autoSend).toMatchObject({ attempted: 1, sent: 0 });
    const send = jest.fn(async () => ({ ok: true }));
    const again = await nightly(s.db, { autoSend: true, send, now: new Date(NOW.getTime() + 24 * 3600 * 1000) });
    expect(again.selected).toBe(0); // nothing changed on the domain
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'auto' }));
    expect(again.autoSend).toEqual({ attempted: 1, sent: 1, skipped: [] });
  });
  test('a backlog of older submit-first drafts does not starve the send-first drafts behind it: the batch is filled after they are excluded', async () => {
    const db = makeDb({ seo_link_domains: [], seo_link_acquisition_paths: [], seo_link_prospects: [], seo_link_placement_authorities: [], seo_link_policy: [policyRow()] });
    const seedDraft = (i, after) => {
      const d = domainRow({ domain: `d${i}.org` }); const p = outreachPath(d, { execution_after_send: after, account_required: !after }); d.best_path_id = p.id; // submit-first = the flag AND an acquire step
      const row = draftedRow(d, p, { target_domain: d.domain, outreach_to_email: `editor@${d.domain}`, updated_at: new Date(EARLIER.getTime() + i * 1000) });
      db._tables.seo_link_domains.push(d); db._tables.seo_link_acquisition_paths.push(p); db._tables.seo_link_prospects.push(row);
      db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: row.id, path_id: p.id, dimension: 'communication', instance_kind: '-', instance_key: '-', level: 'AUTO_OUTREACH', ended_at: null, satisfied_at: null, approval_id: null });
      return row;
    };
    for (let i = 0; i < 120; i += 1) seedDraft(i, false); // 120 submit-first drafts, all older than the batch size
    const sendFirst = seedDraft(120, true); // the newest row is the only one the nightly may send
    const send = jest.fn(async () => ({ ok: true }));
    const r = await bridge.autoSendDecided(db, { send, now: NOW });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: sendFirst.id, mode: 'auto' }));
    expect(r).toEqual({ attempted: 1, sent: 1, skipped: [] });
  });
  test('rows the claim refuses without touching (a customer recipient, a held inbox) do not starve the valid drafts behind them: a refused row is re-stamped behind them, the batch stays bounded', async () => {
    const db = makeDb({ seo_link_domains: [], seo_link_acquisition_paths: [], seo_link_prospects: [], seo_link_placement_authorities: [], seo_link_policy: [policyRow()] });
    const seedDraft = (i) => {
      const d = domainRow({ domain: `d${i}.org` }); const p = outreachPath(d); d.best_path_id = p.id;
      const row = draftedRow(d, p, { target_domain: d.domain, outreach_to_email: `editor@${d.domain}`, updated_at: new Date(EARLIER.getTime() + i * 1000) });
      db._tables.seo_link_domains.push(d); db._tables.seo_link_acquisition_paths.push(p); db._tables.seo_link_prospects.push(row);
      db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: row.id, path_id: p.id, dimension: 'communication', instance_kind: '-', instance_key: '-', level: 'AUTO_OUTREACH', ended_at: null, satisfied_at: null, approval_id: null });
      return row;
    };
    const refused = []; for (let i = 0; i < 120; i += 1) refused.push(seedDraft(i)); // 120 older drafts the claim refuses every night (customer recipients)
    const valid = seedDraft(120);
    const send = jest.fn(async ({ prospectId }) => (prospectId === valid.id ? { ok: true } : { ok: false, code: 'customer_recipient' }));
    // night 1: the batch (100 attempts) is refused rows only — each re-stamped behind the valid draft
    const r1 = await bridge.autoSendDecided(db, { send, now: NOW });
    expect(r1).toMatchObject({ attempted: 100, sent: 0 });
    expect(r1.skipped).toHaveLength(100);
    expect(db._tables.seo_link_prospects.filter((p) => new Date(p.updated_at).getTime() === NOW.getTime())).toHaveLength(100);
    // night 2: the 20 refused rows not yet attempted, then the valid draft (the 21st attempt), then the batch's
    // remaining 79 are re-stamped rows — bounded at 100 again
    const r2 = await bridge.autoSendDecided(db, { send, now: new Date(NOW.getTime() + 24 * 3600 * 1000) });
    expect(r2).toMatchObject({ attempted: 100, sent: 1 });
    expect(send.mock.calls[120][0]).toMatchObject({ prospectId: valid.id, mode: 'auto' });
    expect(send).toHaveBeenCalledTimes(200);
    // a draft edited while the run was refusing it keeps its later timestamp (the next selection's staleness signal)
    const edited = refused[0]; const later = new Date(NOW.getTime() + 48 * 3600 * 1000 + 1);
    const editing = jest.fn(async ({ prospectId }) => { if (prospectId === edited.id) edited.updated_at = later; return { ok: false, code: 'customer_recipient' }; });
    await bridge.autoSendDecided(db, { send: editing, now: new Date(NOW.getTime() + 48 * 3600 * 1000) });
    expect(edited.updated_at).toBe(later);
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

describe('the click sends the text it displayed (§3.6b)', () => {
  test('a draft hash that no longer matches the locked draft refuses inside the claim — nothing sent, no approval written; the current hash sends', async () => {
    const s = scenario();
    await nightly(s.db);
    const shown = M.draftHash(placement(s.db));
    Object.assign(placement(s.db), { outreach_body: `${CLEAN_BODY}\nP.S. edited in another tab after the card loaded.` });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', draftHash: shown })).toMatchObject({ ok: false, code: 'draft_changed', error: expect.stringMatching(/changed while you looked/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(approvals(s.db)).toHaveLength(0);
    expect(placement(s.db).outreach_status).toBe('drafted');
    const current = M.draftHash(placement(s.db));
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', draftHash: current })).ok).toBe(true);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(approvals(s.db)[0]).toMatchObject({ action: 'outreach_send', action_hash: current });
  });
});

describe('the Owner queue Send action', () => {
  test('the card offers Send on a drafted OWNER_OUTREACH row; sendRow routes to the sender as the owner with the acknowledged hash', async () => {
    const s = scenario();
    await nightly(s.db);
    const { cards } = await Q.listOwnerQueue(s.db);
    const row = cards[0].rows.find((r) => r.dimension === 'communication');
    expect(row).toMatchObject({ approvable: true, action: 'outreach_send', draft: { to: 'editor@example.org', subject: 'A resource for your readers', hash: M.draftHash(placement(s.db)), review: { clean: true }, recipient_review: { kind: 'clear' } } });
    const send = jest.fn(async () => ({ ok: true, message_id: 'm', thread_id: 't', authority: { level: 'OWNER_OUTREACH', approval_id: 'a' } }));
    // the click carries the hash of the draft the card displayed — without it the row is refused before the sender
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', reviewedLookupHash: 'h', send })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/hash of the draft/) });
    expect(send).not.toHaveBeenCalled();
    const r = await Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', reviewedLookupHash: 'h', draftHash: row.draft.hash, send });
    expect(send).toHaveBeenCalledWith({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', reviewedLookupHash: 'h', draftHash: row.draft.hash, followUp: false });
    expect(r).toMatchObject({ sent: true, prospectId: s.row.id, message_id: 'm' });
  });
  test('sendRow refuses: no actor, an unknown row, a non-communication row, a leased or released placement; a sender refusal maps to its status with the review attached', async () => {
    const s = scenario();
    await nightly(s.db);
    const row = commRow(s.db);
    const draftHash = M.draftHash(placement(s.db));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: null, draftHash })).rejects.toMatchObject({ status: 400 });
    await expect(Q.sendRow(s.db, { authorityId: uid(), actor: 'Adam', draftHash })).rejects.toMatchObject({ status: 404 });
    s.db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: s.row.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE' });
    await expect(Q.sendRow(s.db, { authorityId: s.db._tables.seo_link_placement_authorities[1].id, actor: 'Adam', draftHash })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/initial send/) });
    placement(s.db).claimed_at = NOW;
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', draftHash })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/leased/) });
    placement(s.db).claimed_at = null;
    const refused = jest.fn(async () => ({ ok: false, code: 'recipient_review_required', error: 'review it', review: { kind: 'ambiguous', lookup_hash: 'h9' } }));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', draftHash, send: refused })).rejects.toMatchObject({ status: 409, code: 'recipient_review_required', review: { lookup_hash: 'h9' }, message: 'review it' });
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', draftHash, send: capped })).rejects.toMatchObject({ status: 429 });
    const stale = jest.fn(async () => ({ ok: false, code: 'draft_changed', error: 'the draft changed while you looked at it' }));
    await expect(Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', draftHash, send: stale })).rejects.toMatchObject({ status: 409, code: 'draft_changed' });
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

// ---------------------------------------------------------------------------
// Step 4 PR 3b — the follow-up (§6.4): one per placement, +10 days, only if no
// reply, drafted before it can be sent, under the communication/followup
// instance, with the fail-closed reply check inside the locked claim.
// ---------------------------------------------------------------------------
const worker = require('../services/seo/link-prospect-worker');
const DAY = 24 * 60 * 60 * 1000;
const LATER = new Date(NOW.getTime() + 11 * DAY); // eleven days on: the follow-up is due
const ours = (id) => ({ id, payload: { headers: [{ name: 'From', value: 'Waves Pest Control <contact@wavespestcontrol.com>' }, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } });
const theirs = (from) => ({ id: 'r1', payload: { headers: [{ name: 'From', value: from }] } });
const followUpRow = (db) => db._tables.seo_link_placement_authorities.find((r) => r.dimension === 'communication' && r.instance_kind === 'followup' && !r.ended_at);
const FOLLOW_UP_BODY = 'Hi Dana,\n\nA quick nudge on the pest-pressure calendar — happy to send anything that helps.\n\nAdam, Waves Pest Control';
// the pitch goes out automatically under the policy, then its follow-up is leased, drafted and decided
async function conversation({ policy = AUTO_POLICY, path = {}, followUpBody = FOLLOW_UP_BODY, decide = true } = {}) {
  const s = scenario({ policy, path });
  await nightly(s.db);
  expect((await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'auto-outreach', mode: 'auto', now: NOW })).ok).toBe(true);
  // the finalize stamps the due date from the wall clock (+10d); the lease sweep reads the wall clock too — backdate it
  placement(s.db).follow_up_due_at = new Date(Date.now() - DAY);
  const leased = await worker.claim({ n: 10, type: 'outreach', followUp: true });
  expect(leased).toHaveLength(1);
  expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: leased[0].lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: followUpBody })).toMatchObject({ ok: true, follow_up_status: 'drafted' });
  if (decide) await nightly(s.db, { now: LATER });
  gmail.sendMessage.mockClear(); // the pitch's send is not the follow-up's
  return s;
}
beforeEach(() => {
  gmail.getThread.mockReset();
  gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1')] }); // silence: only our pitch in the thread
});

describe('the follow-up lifecycle (§6.4)', () => {
  test('the initial send schedules ONE follow-up ten days out; nothing is leased before it is due', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', now: NOW });
    const p = placement(s.db);
    expect(p).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'none' });
    expect(new Date(p.follow_up_due_at).getTime() - new Date(p.outreach_sent_at).getTime()).toBe(10 * DAY);
    // not due yet: the sweep leases nothing (the store's clock is real time — the due date is ten days ahead of NOW... which is in the past here)
    p.follow_up_due_at = new Date(Date.now() + DAY);
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    p.follow_up_due_at = new Date(Date.now() - DAY);
    const leased = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(leased).toHaveLength(1);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'due', claimed_by: 'hermes' });
    // a leased follow-up is not re-leased; a placed row on a SEND-FIRST path is not a follow-up candidate
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
  });
  test('the drafted report parks the follow-up on its own columns — the lifecycle, the pitch and the attempt count untouched; failed returns it to due; skipped closes it; a placement outcome is refused', async () => {
    const s = await conversation({ decide: false });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'drafted', follow_up_subject: 'Re: A resource for your readers', follow_up_body: FOLLOW_UP_BODY, claimed_at: null, outreach_subject: 'A resource for your readers' });
    expect(placement(s.db).attempts).toBeUndefined();
    // a second lease of the same row: drafted is not due
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    let [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'placed', lease_token: l.lease_token, live_url: 'https://example.org/x' })).toMatchObject({ ok: false, code: 'not_follow_up_outcome' });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'failed', lease_token: l.lease_token })).toMatchObject({ ok: true, follow_up_status: 'due' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'due', claimed_at: null });
    [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'skipped', lease_token: l.lease_token, notes: 'publisher closed' })).toMatchObject({ ok: true, follow_up_status: 'skipped' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'publisher closed' });
    // a stale lease writes nothing
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'x', outreach_body: 'y' })).toMatchObject({ ok: false });
  });
  test('the stale sweep releases a stuck follow-up lease (the row is not `prospect`)', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', claimed_at: new Date(Date.now() - 8 * 60 * 60 * 1000), claimed_by: 'hermes' });
    expect(await worker.sweepExpiredClaims(6)).toEqual({ released: 1 });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', claimed_at: null });
  });
});

describe('the follow-up decision (§6.3 2c on the follow-up draft)', () => {
  test('a drafted follow-up makes the domain stale and opens communication/followup:1 — AUTO_OUTREACH on a clean draft, the initial instance stays satisfied', async () => {
    const s = await conversation();
    expect(commRow(s.db)).toMatchObject({ instance_kind: '-', satisfied_reason: 'sent' });
    expect(followUpRow(s.db)).toMatchObject({ instance_key: 'followup:1', level: 'AUTO_OUTREACH' });
    expect(followUpRow(s.db).satisfied_at).toBeFalsy();
    expect(placement(s.db).status).toBe('contacted'); // never parked
  });
  test('an unclean follow-up draft is the owner\'s (OWNER_OUTREACH); the Owner queue lists it on the contacted row with the follow-up draft and its hash', async () => {
    const s = await conversation({ followUpBody: `${FOLLOW_UP_BODY}\nWe would gladly link back to you.` });
    expect(followUpRow(s.db)).toMatchObject({ level: 'OWNER_OUTREACH', reason: 'no lint-clean draft yet' });
    const { cards } = await Q.listOwnerQueue(s.db);
    expect(cards).toHaveLength(1);
    const row = cards[0].rows.find((r) => r.instance_kind === 'followup');
    expect(row).toMatchObject({ action: 'outreach_followup', approvable: true, draft: { subject: 'Re: A resource for your readers', hash: M.followUpHash(placement(s.db)), follow_up: true } });
    expect(row.draft.review.clean).toBe(false);
    expect(cards[0].rows.find((r) => r.instance_kind === '-').approvable).toBe(false); // satisfied
  });
  test('a skipped follow-up ends its instance on the next run (no longer required)', async () => {
    const s = await conversation();
    Object.assign(placement(s.db), { follow_up_status: 'skipped', follow_up_skipped_reason: 'reply', updated_at: new Date(LATER.getTime() + 1000) });
    await nightly(s.db, { now: new Date(LATER.getTime() + DAY) });
    expect(followUpRow(s.db)).toBeUndefined();
    expect(s.db._tables.seo_link_placement_authorities.find((r) => r.instance_kind === 'followup')).toMatchObject({ end_outcome: 'superseded' });
  });
});

describe('the follow-up send', () => {
  test('silence proven ⇒ the follow-up goes out IN the pitch\'s thread answering its Message-ID, satisfies followup:1, counts against the cap, leaves the lifecycle alone; a second attempt is already_sent', async () => {
    const s = await conversation();
    gmail.sendMessage.mockResolvedValue({ id: 'msg2', threadId: 'thr1' });
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER });
    expect(r).toMatchObject({ ok: true, message_id: 'msg2', authority: { level: 'AUTO_OUTREACH', approval_id: null } });
    expect(gmail.getThread).toHaveBeenCalledWith('thr1');
    expect(gmail.sendMessage).toHaveBeenLastCalledWith('editor@example.org', 'Re: A resource for your readers', expect.stringMatching(/quick nudge/), 'thr1', '<msg1@mail.gmail.com>');
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'sent', follow_up_send_token: null, outreach_thread_ref: 'thr1' });
    expect(placement(s.db).follow_up_sent_at).toBeTruthy();
    expect(followUpRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
    expect(await Outreach.dailySendCount(s.db, LATER)).toBe(1);
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'already_sent' });
  });
  test('a reply in the thread skips the follow-up for good (nothing sent, no approval, the conversation is the owner\'s); a bounce the same', async () => {
    const s = await conversation();
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), theirs('Dana <editor@example.org>')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'reply_received' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'reply' });
    expect(approvals(s.db)).toHaveLength(0);
    const t = await conversation();
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), theirs('Mail Delivery Subsystem <mailer-daemon@googlemail.com>')] });
    expect(await Outreach.sendOutreach({ prospectId: t.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(t.db)), now: LATER })).toMatchObject({ ok: false, code: 'bounced' });
    expect(placement(t.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: 'bounce' });
  });
  test('a lookup failure, an empty thread or a missing thread ref refuses without writing (fail-closed): the draft stays for a later attempt, no approval', async () => {
    const s = await conversation();
    gmail.getThread.mockRejectedValue(new Error('ECONNRESET'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed' });
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).follow_up_status).toBe('drafted');
    expect(placement(s.db).follow_up_attempted_at).toBeFalsy();
    expect(approvals(s.db)).toHaveLength(0);
    placement(s.db).outreach_thread_ref = null;
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed' });
  });
  test('the owner\'s click on an OWNER_OUTREACH follow-up writes an outreach_followup approval bound to the follow-up hash, sends, and consumes it; the queue routes it with the kind', async () => {
    const s = await conversation({ followUpBody: `${FOLLOW_UP_BODY}\nWe would gladly link back to you.` });
    const row = followUpRow(s.db);
    const send = jest.fn(async () => ({ ok: true, message_id: 'm' }));
    await Q.sendRow(s.db, { authorityId: row.id, actor: 'Adam', draftHash: M.followUpHash(placement(s.db)), send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'owner', followUp: true }));
    // the real sender: the click is the approval
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized' }); // an owner level never sends automatically
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.draftHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'draft_changed' }); // the PITCH's hash is not the follow-up's
    const r = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER });
    expect(r).toMatchObject({ ok: true, authority: { level: 'OWNER_OUTREACH' } });
    expect(approvals(s.db)).toHaveLength(1);
    expect(approvals(s.db)[0]).toMatchObject({ action: 'outreach_followup', instance_key: 'followup:1', action_hash: M.followUpHash(placement(s.db)) });
    expect(approvals(s.db)[0].consumed_at).toBeTruthy();
    expect(followUpRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
  });
  test('the follow-up refuses on a lifecycle outside FOLLOW_UP_STATUSES(path): a placed row on a send-first path, a lost row; and with the authority gate off', async () => {
    const s = await conversation();
    placement(s.db).status = 'placed';
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_actionable', error: expect.stringMatching(/placed/) });
    placement(s.db).status = 'lost';
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_actionable' });
    placement(s.db).status = 'contacted';
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
  test('a follow-up on a SUBMIT-FIRST path follows the Judge-owned row (placed) without demoting it', async () => {
    // a submit-first path (account, then the pitch): the bridge decides the prospect; the acquire then places it and the
    // LATE SEND (PR 4) stamps the pitch on the placed row — emulated here on the rows the bridge wrote
    const s = scenario({ policy: AUTO_POLICY, path: { execution_after_send: false, account_required: true } });
    await nightly(s.db);
    const exec = s.db._tables.seo_link_placement_authorities.find((r) => r.dimension === 'execution' && r.instance_kind === '-');
    Object.assign(exec, { satisfied_at: NOW, satisfied_reason: 'placed' });
    Object.assign(commRow(s.db), { satisfied_at: NOW, satisfied_reason: 'sent' });
    Object.assign(placement(s.db), { status: 'placed', parked_from_status: null, outreach_status: 'sent', outreach_sent_at: NOW, outreach_thread_ref: 'thr1', follow_up_status: 'none', follow_up_due_at: new Date(Date.now() - DAY), live_url: 'https://example.org/resources', updated_at: NOW });
    const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(l).toBeTruthy();
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: true });
    await nightly(s.db, { now: LATER });
    expect(followUpRow(s.db)).toMatchObject({ level: 'AUTO_OUTREACH' });
    expect(placement(s.db).status).toBe('placed');
    gmail.sendMessage.mockResolvedValue({ id: 'msg2', threadId: 'thr1' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: true });
    expect(placement(s.db)).toMatchObject({ status: 'placed', follow_up_status: 'sent' });
    expect(followUpRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
  });
  test('the nightly dispatches follow-ups after the pitches; the cap ends both', async () => {
    const s = await conversation();
    const send = jest.fn(async () => ({ ok: true }));
    const r = await nightly(s.db, { now: LATER, autoSend: true, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'auto', followUp: true }));
    expect(r.autoSend).toEqual({ attempted: 1, sent: 1, skipped: [] });
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    const t = await conversation();
    t.db._tables.seo_link_prospects.push(draftedRow(t.d, t.p, { location_key: 'x', target_domain: 'example.org', outreach_to_email: 'other@example.org', follow_up_status: 'none' }));
    // (a second drafted pitch on the same domain is not this test's concern — the cap refusal on the first attempt ends the run)
    const r2 = await nightly(t.db, { now: LATER, autoSend: true, send: capped });
    expect(capped).toHaveBeenCalledTimes(1);
    expect(r2.autoSend.skipped).toEqual([{ id: t.row.id, code: 'rate_limited', follow_up: true }]);
  });
  test('reconciling an ambiguous follow-up: sent settles it (instance satisfied, lifecycle untouched); requeue returns it to drafted with the attempt cleared', async () => {
    const s = await conversation();
    gmail.sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'send_failed' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'send_error', follow_up_send_token: null });
    expect(placement(s.db).follow_up_attempted_at).toBeTruthy();
    expect((await Outreach.inboxConflict(s.db, { recipient: 'editor@example.org', excludeId: 'none' }))?.id).toBe(s.row.id); // ambiguous ⇒ held
    // the pitch's reconcile does not touch it
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'not_reconcilable' });
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_attempted_at: null });
    Object.assign(placement(s.db), { follow_up_status: 'send_error' });
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent' });
    expect(followUpRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
  });
});

describe('Codex r1 on #3854', () => {
  test('P1: a Watch / Reject, a path disproof or a lifecycle move that commits between the candidate read and the lease is honoured under the locks — nothing is leased', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    // the owner parks the domain after the candidate read (the first resolve on seo_link_domains is the nonclaimable-state read; the second, under the lock, sees Watch)
    let flipped = false;
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_domains' && !flipped) { flipped = true; db._tables.seo_link_domains[0].agent_state = 'watching'; } };
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    expect(placement(s.db).claimed_at).toBeFalsy();
    expect(s.db._raws.some((r) => /FOR UPDATE seo_link_prospects/.test(r))).toBe(true);
    s.db._beforeResolve = null;
    s.db._tables.seo_link_domains[0].agent_state = 'acquiring';
    // the path is disproven under the lock
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_acquisition_paths') db._tables.seo_link_acquisition_paths[0].confidence = '0'; };
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    s.db._beforeResolve = null;
    storedPath(s.db).confidence = '0.80';
    // the row moved to lost under the lock
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects') db._tables.seo_link_prospects[0].status = 'lost'; };
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    s.db._beforeResolve = null;
    placement(s.db).status = 'contacted';
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toHaveLength(1);
    expect(s.db._raws.some((r) => /link_prospect_domain|advisory/i.test(r))).toBe(true); // the per-domain advisory lock every domain writer takes
  });
  test('P2: a failed reply check on an AUTOMATIC attempt routes the follow-up to the owner: the marker lands, the auto path refuses, the nightly re-decides OWNER_OUTREACH, the owner\'s click re-runs the check; a requeue clears the marker', async () => {
    const s = await conversation();
    gmail.getThread.mockRejectedValue(new Error('ECONNRESET'));
    const ATTEMPT = new Date(LATER.getTime() + 1000); // after the decision (a re-decision follows a later placement change)
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: ATTEMPT })).toMatchObject({ ok: false, code: 'reply_check_failed', error: expect.stringMatching(/routed to the owner/) });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_skipped_reason: 'reply_check_failed' });
    expect(M.followUpReview(placement(s.db))).toMatchObject({ clean: false, reason: expect.stringMatching(/owner sends it/) });
    // the marker alone stops the next automatic attempt, before the nightly re-decides
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/owner/) });
    await nightly(s.db, { now: new Date(LATER.getTime() + DAY) });
    expect(followUpRow(s.db)).toMatchObject({ level: 'OWNER_OUTREACH' }); // the card's review line carries the why (followUpReview)
    const r = await nightly(s.db, { now: new Date(LATER.getTime() + 2 * DAY), autoSend: true, send: jest.fn(async () => ({ ok: true })) });
    expect(r.autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
    // the owner's click: the check runs again, fail-closed on a failure, sends on silence
    gmail.getThread.mockRejectedValueOnce(new Error('timeout'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed', error: expect.stringMatching(/retry later/) });
    gmail.sendMessage.mockResolvedValue({ id: 'msg2', threadId: 'thr1' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: true, authority: { level: 'OWNER_OUTREACH' } });
    // a requeue after an ambiguous send clears the marker with the attempt
    const t = await conversation();
    Object.assign(placement(t.db), { follow_up_status: 'send_error', follow_up_skipped_reason: 'reply_check_failed' });
    expect((await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).ok).toBe(true);
    expect(placement(t.db).follow_up_skipped_reason).toBeNull();
  });
  test('audit: an AUTO follow-up whose LOCKED text no longer passes the follow-up\'s own review (a subject edited off "Re: …") is refused automatically; the owner may still send it', async () => {
    const s = await conversation();
    expect(followUpRow(s.db).level).toBe('AUTO_OUTREACH');
    placement(s.db).follow_up_subject = 'One more resource for you';
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/no longer clean/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(placement(s.db).follow_up_status).toBe('drafted');
    gmail.sendMessage.mockResolvedValue({ id: 'msg2', threadId: 'thr1' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/no longer clean/) }); // an AUTO row: no approval binds an unclean text to it — the nightly re-decides it OWNER_OUTREACH first
  });
  test('P2: a crashed follow-up send is aged from follow_up_attempted_at — a verifier bump of updated_at never hides it', async () => {
    const s = await conversation();
    Object.assign(placement(s.db), { follow_up_status: 'sending', follow_up_send_token: 'tok', follow_up_attempted_at: new Date(Date.now() - 60 * 60 * 1000), updated_at: new Date() }); // crashed an hour ago; the verifier touched the row just now
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent' });
    const t = await conversation();
    Object.assign(placement(t.db), { follow_up_status: 'sending', follow_up_send_token: 'tok', follow_up_attempted_at: new Date(), updated_at: new Date(Date.now() - 60 * 60 * 1000) }); // genuinely in flight
    expect(await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: false, code: 'send_in_flight' });
  });
});

describe('Codex r2 on #3854', () => {
  test('P1: a recovered row whose previous follow-up is still ambiguous takes no new pitch until it is reconciled', async () => {
    const s = await conversation();
    gmail.sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'send_failed' });
    // the verifier lost the link and recovery reopened the row (the pitch's state reset; the follow-up's is not the recovery's to clear — it refuses on an ambiguous one, emulated here as if it had not)
    Object.assign(placement(s.db), { status: 'prospect', outreach_status: 'drafted', outreach_sent_at: null, outreach_attempted_at: null, outreach_thread_ref: null });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', draftHash: M.draftHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'needs_reconcile' });
    expect(Outreach.checkSendPreconditions({ prospect: { ...placement(s.db) }, gateOn: true, dailyCount: 0, cap: 12 })).toMatchObject({ ok: false, code: 'needs_reconcile' });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1); // the failed follow-up only
    // settled ⇒ the pitch may go again
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).ok).toBe(true);
    expect(Outreach.checkSendPreconditions({ prospect: { ...placement(s.db) }, gateOn: true, dailyCount: 0, cap: 12 }).code).not.toBe('needs_reconcile');
  });
  test('P1: a follow-up drafted against a path revised or superseded during the lease is discarded and returned to due (never a draft nothing can send)', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    let [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(placement(s.db).leased_path_revision).toBe(1);
    storedPath(s.db).revision = 2; // the investigator revised the path in place while the drafter held the lease
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'path_moved' });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', follow_up_subject: null, claimed_at: null });
    [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true }); // re-leased at the current revision
    expect(placement(s.db).leased_path_revision).toBe(2);
    storedPath(s.db).superseded_by = uid();
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'path_moved' });
    storedPath(s.db).superseded_by = null;
    [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: true, follow_up_status: 'drafted' });
  });
  test('P2: a lane edit out of outreach committed under the lock leases nothing', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects') db._tables.seo_link_prospects[0].link_type = 'directory'; };
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    s.db._beforeResolve = null;
    expect(placement(s.db).claimed_at).toBeFalsy();
  });
  test('P2: a pitch reconciled as sent WITHOUT a Gmail thread reference schedules no follow-up (the reply check could never prove silence); with one, it does', async () => {
    const s = scenario({ policy: AUTO_POLICY });
    await nightly(s.db);
    Object.assign(placement(s.db), { outreach_status: 'send_error', outreach_send_token: null, outreach_thread_ref: null });
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent' });
    expect(placement(s.db).follow_up_due_at).toBeFalsy(); // (the store seeds no follow_up_status key; the DB default is 'none')
    const t = scenario({ policy: AUTO_POLICY });
    await nightly(t.db);
    Object.assign(placement(t.db), { outreach_status: 'send_error', outreach_send_token: null, outreach_thread_ref: 'thr9' });
    expect((await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(placement(t.db).follow_up_due_at).toBeTruthy();
  });
});

describe('Codex r3 on #3854', () => {
  test('P2: the follow-up report reads the path revision and accepts the draft in ONE transaction, under the domain lock and the row + path FOR UPDATE (the lease\'s own locks)', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    s.db._raws.length = 0;
    const tx = jest.spyOn(s.db, 'transaction');
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: true, follow_up_status: 'drafted' });
    expect(tx).toHaveBeenCalledTimes(1); // the revision check and the lease-conditional acceptance are not separate autocommit statements
    const raws = s.db._raws.map(String);
    expect(raws.some((r) => /link_prospect_domain|advisory/i.test(r))).toBe(true);
    expect(raws).toContain('FOR UPDATE seo_link_prospects');
    expect(raws).toContain('FOR UPDATE seo_link_acquisition_paths'); // the investigator's revise / supersede waits on this lock
    tx.mockRestore();
    // the locked row decides, not the caller's read: a revision that landed under the lock discards the draft in the same transaction
    const [l2] = (Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, claimed_at: null }), await worker.claim({ n: 10, type: 'outreach', followUp: true }));
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_acquisition_paths') db._tables.seo_link_acquisition_paths[0].revision = 2; };
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l2.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'path_moved' });
    s.db._beforeResolve = null;
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', follow_up_subject: null, claimed_at: null });
  });
  test('P2: a silent conversation closes 45 ET days after its last send and releases the inbox; a reply keeps it open; a failed thread read waits; a closed one is not re-read', async () => {
    const s = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).ok).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent' });
    expect(placement(s.db).conversation_closed_at).toBeFalsy();
    const sentAt = new Date(placement(s.db).follow_up_sent_at); // the finalize stamps the wall clock
    const day = (n) => new Date(sentAt.getTime() + n * DAY);
    // a second placement addressed to the same editor: the inbox guard holds while the conversation is open
    const other = draftedRow(s.d, s.p, { target_page: '/mosquito/', outreach_to_email: 'Editor@Example.org' });
    s.db._tables.seo_link_prospects.push(other);
    const conflict = () => s.db.transaction((trx) => Outreach.inboxConflict(trx, { recipient: other.outreach_to_email, excludeId: other.id }));
    expect((await conflict()).id).toBe(s.row.id);
    gmail.getThread.mockClear(); // the follow-up send's reply check is not the sweep's read
    // not yet: the window is 45 ET days from the LAST send (the follow-up's)
    expect(await Outreach.closeSilentConversations({ now: day(43) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(gmail.getThread).not.toHaveBeenCalled();
    // an inbound message = the owner's conversation: read, left open, nothing written
    gmail.getThread.mockResolvedValueOnce({ id: 'thr1', messages: [ours('msg1'), ours('msg2'), theirs('Dana <dana@example.org>')] });
    expect(await Outreach.closeSilentConversations({ now: day(47) })).toEqual({ scanned: 1, closed: 0, open: 1, failed: 0 });
    expect(placement(s.db).conversation_closed_at).toBeFalsy();
    // a thread read that fails proves nothing: retried next sweep
    gmail.getThread.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await Outreach.closeSilentConversations({ now: day(47) })).toEqual({ scanned: 1, closed: 0, open: 0, failed: 1 });
    expect(placement(s.db).conversation_closed_at).toBeFalsy();
    // silence (our two messages only) ⇒ closed: the stamp, the note, and the inbox released
    const at = day(47);
    expect(await Outreach.closeSilentConversations({ now: at })).toEqual({ scanned: 1, closed: 1, open: 0, failed: 0 });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent', conversation_closed_at: at });
    expect(placement(s.db).notes).toMatch(/Conversation closed .* silent 45 ET days/);
    expect(Outreach.conversationOpen(placement(s.db))).toBe(false);
    expect(await conflict()).toBeNull();
    expect(s.db._raws.some((r) => /link_prospect_domain|advisory/i.test(String(r)))).toBe(true); // stamped under the per-domain lock
    // closed rows leave the candidate set — no second thread read
    gmail.getThread.mockClear();
    expect(await Outreach.closeSilentConversations({ now: day(60) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(gmail.getThread).not.toHaveBeenCalled();
  });
  test('P2: a bounced pitch (mailer-daemon only) is no inbound match — the conversation closes; a pitch without a thread reference never closes here', async () => {
    const s = await conversation();
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), theirs('Mail Delivery Subsystem <mailer-daemon@googlemail.com>')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'bounced' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'bounce' });
    const sentAt = new Date(placement(s.db).outreach_sent_at); // no follow-up send: the window runs from the pitch
    expect(await Outreach.closeSilentConversations({ now: new Date(sentAt.getTime() + 47 * DAY) })).toEqual({ scanned: 1, closed: 1, open: 0, failed: 0 });
    expect(placement(s.db).conversation_closed_at).toBeTruthy();
    const t = await conversation();
    Object.assign(placement(t.db), { follow_up_status: 'skipped', follow_up_skipped_reason: 'reply', outreach_thread_ref: null });
    expect(await Outreach.closeSilentConversations({ now: new Date(Date.now() + 60 * DAY) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(placement(t.db).conversation_closed_at).toBeFalsy();
  });
});
