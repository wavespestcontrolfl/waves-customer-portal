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
jest.mock('../services/seo/link-prospect-verifier', () => ({ reconcileOutreach: jest.fn(async () => ({ matched: 0, ambiguous: 0 })) }));
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
const { addETDaysAtWallClock } = require('../utils/datetime-et');
const { claimProspectDomain } = require('../services/seo/prospect-domain-lock');

const NOW = new Date('2026-09-03T07:35:00Z');
const selection = require('../services/seo/link-authority-selection');
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
    // The cap counts TODAY's attempts in ET: the send runs on the fixture clock, not the wall clock (the assertion drifted off the fixture day on 2026-09-04).
    expect(await Outreach.sendOutreach({ prospectId: one.row.id, mode: 'auto', now: NOW })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    // the owner's click: the policy cap (1, reached) does not apply; the hard cap (12) is not reached
    commRow(one.db).level = 'OWNER_OUTREACH';
    const r = await Outreach.sendOutreach({ prospectId: one.row.id, approvedBy: 'Adam', mode: 'owner', now: NOW });
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
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', now: NOW })).toMatchObject({ ok: false, code: 'rate_limited' });
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
    // no follow-up is scheduled outside the contract (nothing could ever send it): settled skipped so the conversation
    // can complete and the closure sweep release the inbox (Codex r12 P1); the reconcile schedules the same way
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_due_at: null, follow_up_skipped_reason: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    const u = scenario();
    Object.assign(placement(u.db), { outreach_status: 'send_error', outreach_send_token: null, outreach_thread_ref: 'thr-x' });
    expect((await Outreach.reconcileSendError({ prospectId: u.row.id, outcome: 'sent', approvedBy: 'Adam' })).ok).toBe(true);
    expect(placement(u.db)).toMatchObject({ outreach_status: 'sent', follow_up_status: 'skipped', follow_up_due_at: null });
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
  test('a submit-first Judge-owned row (placed / live / indexed) holds its inbox while its ONE follow-up is still owed — scheduled, due or drafted — and releases it once the follow-up is sent or skipped; a send-first row that reached live holds nothing (Codex r5)', async () => {
    const d = domainRow();
    const submitFirst = outreachPath(d, { execution_after_send: false, account_required: true });
    const sendFirst = outreachPath(d);
    const row = draftedRow(d, submitFirst, { status: 'placed', outreach_status: 'sent', outreach_sent_at: NOW, outreach_thread_ref: 'thr1', follow_up_status: 'none', follow_up_due_at: LATER, live_url: 'https://example.org/resources' });
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [submitFirst, sendFirst], seo_link_prospects: [row] });
    const stored = db._tables.seo_link_prospects[0]; // the store copies its seed — edit the stored row
    const held = async () => (await Outreach.inboxConflict(db, { recipient: 'editor@example.org' }))?.id || null;
    for (const st of ['placed', 'live', 'indexed']) {
      stored.status = st;
      for (const fu of ['none', 'due', 'drafted']) { stored.follow_up_status = fu; expect(await held()).toBe(row.id); }
      for (const fu of ['sent', 'skipped']) { stored.follow_up_status = fu; expect(await held()).toBeNull(); }
    }
    Object.assign(stored, { status: 'live', follow_up_status: 'drafted', path_id: sendFirst.id }); // the same lifecycle on a send-first path: the follow-up is no longer sendable — nothing owed, the inbox is free
    expect(await held()).toBeNull();
    Object.assign(stored, { path_id: submitFirst.id, follow_up_status: 'none', follow_up_due_at: null }); // a pitch reconciled without a thread ref grows no follow-up: nothing owed
    expect(await held()).toBeNull();
    Object.assign(stored, { follow_up_status: 'sending' }); // an ambiguous follow-up send holds it whatever the path
    expect(await held()).toBe(row.id);
  });
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
    expect(new Date(p.follow_up_due_at)).toEqual(M.followUpDueAt(p.outreach_sent_at)); // ten ET calendar days at the send's ET wall-clock time
    expect(new Date(p.follow_up_due_at).getTime()).toBeGreaterThan(new Date(p.outreach_sent_at).getTime() + 9 * DAY);
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
    const dueBefore = placement(s.db).follow_up_due_at;
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'failed', lease_token: l.lease_token })).toMatchObject({ ok: true, follow_up_status: 'due' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'due', claimed_at: null, follow_up_attempts: 1 });
    expect(new Date(placement(s.db).follow_up_due_at).getTime()).toBeGreaterThan(new Date(dueBefore).getTime()); // a drafter failure rotates the follow-up behind every one due now (Codex r9 P1)
    [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'skipped', lease_token: l.lease_token, notes: 'publisher closed' })).toMatchObject({ ok: true, follow_up_status: 'skipped' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'publisher closed' });
    // a stale lease writes nothing
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'x', outreach_body: 'y' })).toMatchObject({ ok: false });
  });
  test('P1: drafter failures on a follow-up are counted and capped at the worker\'s MAX_ATTEMPTS — the follow-up is skipped, not re-leased forever; a discarded draft is not a failure', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    for (let i = 1; i < worker.MAX_ATTEMPTS; i++) {
      const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
      expect(l).toBeTruthy();
      expect(await worker.report({ prospect_id: s.row.id, outcome: 'failed', lease_token: l.lease_token, notes: 'drafter produced no usable follow-up' })).toMatchObject({ ok: true, follow_up_status: 'due' });
      expect(placement(s.db).follow_up_attempts).toBe(i);
    }
    const [last] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'failed', lease_token: last.lease_token, notes: 'drafter produced no usable follow-up' })).toMatchObject({ ok: true, follow_up_status: 'skipped' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_attempts: worker.MAX_ATTEMPTS, follow_up_skipped_reason: expect.stringMatching(/^drafter failed 4 times/) });
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    // a draft discarded because the row is no longer claimable returns to due WITHOUT counting (not the drafter's failure)
    const t = await conversation({ decide: false });
    Object.assign(placement(t.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    const [l2] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    t.db._tables.seo_link_domains[0].agent_state = 'watching';
    expect(await worker.report({ prospect_id: t.row.id, outcome: 'drafted', lease_token: l2.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'not_eligible' });
    expect(placement(t.db)).toMatchObject({ follow_up_status: 'due' });
    expect(placement(t.db).follow_up_attempts || 0).toBe(0);
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
  test('the nightly dispatches due follow-ups BEFORE the pitches (a cap-filling pitch backlog never starves them); the cap ends both', async () => {
    const s = await conversation();
    const send = jest.fn(async () => ({ ok: true }));
    const r = await nightly(s.db, { now: LATER, autoSend: true, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prospectId: s.row.id, mode: 'auto', followUp: true }));
    expect(r.autoSend).toEqual({ attempted: 1, sent: 1, skipped: [] });
    const capped = jest.fn(async () => ({ ok: false, code: 'rate_limited' }));
    const t = await conversation();
    t.db._tables.seo_link_prospects.push(draftedRow(t.d, t.p, { location_key: 'x', target_domain: 'example.org', outreach_to_email: 'other@example.org', follow_up_status: 'none' }));
    // the follow-up is attempted first — the cap refusal on it ends the run before the drafted pitch is tried
    const r2 = await nightly(t.db, { now: LATER, autoSend: true, send: capped });
    expect(capped).toHaveBeenCalledTimes(1);
    expect(r2.autoSend.skipped).toEqual([{ id: t.row.id, code: 'rate_limited', follow_up: true }]);
    // the order under an open cap: the due follow-up, then a clean pitch on ANOTHER domain the same nightly decided AUTO
    const u = await conversation();
    const d2 = domainRow({ domain: 'second.example' });
    const p2 = outreachPath(d2);
    d2.best_path_id = p2.id;
    u.db._tables.seo_link_domains.push(d2);
    u.db._tables.seo_link_acquisition_paths.push(p2);
    u.db._tables.seo_link_prospects.push(draftedRow(d2, p2, { target_domain: 'second.example', outreach_to_email: 'ed@second.example', follow_up_status: 'none' }));
    const order = jest.fn(async () => ({ ok: true }));
    await nightly(u.db, { now: LATER, autoSend: true, send: order });
    expect(order.mock.calls.map((c) => c[0].followUp)).toEqual([true, false]);
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
    // the nightly's OWN dispatch: the attempt carries the run's clock, EQUAL to the decision's — the failure stamp
    // cannot post-date decided_at, so the selection must re-select the domain on the marker (Codex r8 P1)
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed', error: expect.stringMatching(/routed to the owner/) });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_skipped_reason: 'reply_check_failed', updated_at: LATER });
    expect(followUpRow(s.db)).toMatchObject({ level: 'AUTO_OUTREACH', decided_at: LATER });
    expect(M.followUpReview(placement(s.db))).toMatchObject({ clean: false, reason: expect.stringMatching(/owner sends it/) });
    expect((await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).map((x) => x.why)).toEqual(['stale']);
    // the marker alone stops the next automatic attempt, before the nightly re-decides
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/owner/) });
    expect(await nightly(s.db, { now: new Date(LATER.getTime() + DAY) })).toMatchObject({ selected: 1 });
    expect(followUpRow(s.db)).toMatchObject({ level: 'OWNER_OUTREACH' }); // the card's review line carries the why (followUpReview)
    // the card reads the marker too (Codex r9 P1): its staleness test re-decides on the SAME inputs as the bridge — Send is offered
    const card = (await Q.listOwnerQueue(s.db)).cards[0].rows.find((r) => r.instance_kind === 'followup');
    expect(card).toMatchObject({ level: 'OWNER_OUTREACH', approvable: true, why_not: null, action: 'outreach_followup', draft: { follow_up: true, review: { clean: false, reason: expect.stringMatching(/owner sends it/) } } });
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).toEqual([]); // converged: the marker on an OWNER row is settled
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
  test('P1: an AUTO follow-up to a shared business domain is a stable refusal — marked recipient_review_required, re-selected on the marker, re-decided OWNER_OUTREACH; the card offers Send with the acknowledged hash; the send clears the marker', async () => {
    const s = await conversation();
    s.db._tables.customers.push({ id: 'c7', email: 'ads@example.org' }); // a lead / customer on the recipient's domain appeared after the pitch
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'recipient_review_required', review: { kind: 'ambiguous' }, error: expect.stringMatching(/routed to the owner/) });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_skipped_reason: 'recipient_review_required' });
    expect(M.followUpReview(placement(s.db))).toMatchObject({ clean: false, reason: expect.stringMatching(/owner reviews the match/) });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/owner/) }); // the marker alone stops the next automatic attempt
    expect((await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).map((x) => x.why)).toEqual(['stale']);
    expect(await nightly(s.db, { now: new Date(LATER.getTime() + DAY) })).toMatchObject({ selected: 1 });
    expect(followUpRow(s.db)).toMatchObject({ level: 'OWNER_OUTREACH' });
    const card = (await Q.listOwnerQueue(s.db)).cards[0].rows.find((r) => r.instance_kind === 'followup');
    expect(card).toMatchObject({ approvable: true, why_not: null, draft: { follow_up: true, recipient_review: { kind: 'ambiguous' } } });
    const first = await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER });
    expect(first).toMatchObject({ ok: false, code: 'recipient_review_required' });
    gmail.sendMessage.mockResolvedValue({ id: 'msg2', threadId: 'thr1' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), reviewedLookupHash: first.review.lookup_hash, now: LATER })).toMatchObject({ ok: true, authority: { level: 'OWNER_OUTREACH' } });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'sent', follow_up_skipped_reason: null });
  });
  test('P2: the thread\'s recipient became a customer contact — the follow-up ENDS (skipped, customer_recipient) on either mode: nothing to re-address, the conversation completes', async () => {
    const s = await conversation();
    s.db._tables.customers.push({ id: 'c8', email: 'editor@example.org', service_contact_email: null, service_contact2_email: null, service_contact3_email: null });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'customer_recipient', error: expect.stringMatching(/follow-up is closed/) });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_skipped_reason: 'customer_recipient' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    // not actionable any more — by the owner either; the nightly has nothing to dispatch
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'no_draft' }); // a skipped follow-up has no draft to send
    const r = await nightly(s.db, { now: new Date(LATER.getTime() + DAY), autoSend: true, send: jest.fn(async () => ({ ok: true })) });
    expect(r.autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
  });
  test('P2: a follow-up drafted against a path later revised IN PLACE is settled at the send: back to due, the draft cleared, re-leased against the current route', async () => {
    const s = await conversation();
    Object.assign(storedPath(s.db), { revision: 2, revision_communication: 2, updated_at: new Date(LATER.getTime() + 1000) }); // the investigator revised the route after the draft was accepted
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', leased_path_revision: 1 });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'path_moved', error: expect.stringMatching(/re-drafted/) });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'due', follow_up_subject: null, follow_up_body: null });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    placement(s.db).follow_up_due_at = new Date(Date.now() - DAY);
    const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(l).toBeTruthy();
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', leased_path_revision: 2 });
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
  test('P2: a path SUPERSEDED after the follow-up was DRAFTED retires it at the send (skipped) — a disproof alone keeps the plain refusal', async () => {
    const s = await conversation();
    storedPath(s.db).superseded_by = uid();
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'path_moved', error: expect.stringMatching(/retired/) });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/superseded/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    const t = await conversation();
    storedPath(t.db).confidence = 0; // disproven, not superseded: may be re-assessed — the draft waits
    expect(await Outreach.sendOutreach({ prospectId: t.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'path_moved' });
    expect(placement(t.db).follow_up_status).toBe('drafted');
  });
  test('P2: a requeue of an ambiguous follow-up whose path was SUPERSEDED or whose domain RE-RANKED meanwhile retires it (Codex r15) — never "Returned to drafts" on a frozen path', async () => {
    const s = await conversation();
    Object.assign(placement(s.db), { follow_up_status: 'send_error', follow_up_send_token: null });
    storedPath(s.db).superseded_by = uid();
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/superseded/) });
    const t = await conversation();
    Object.assign(placement(t.db), { follow_up_status: 'send_error', follow_up_send_token: null });
    const other = outreachPath(t.d); t.db._tables.seo_link_acquisition_paths.push(other); t.db._tables.seo_link_domains[0].best_path_id = other.id;
    expect(await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(t.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/re-ranked/) });
    // 'sent' still settles as sent whatever the route did
    const u = await conversation();
    Object.assign(placement(u.db), { follow_up_status: 'send_error', follow_up_send_token: null });
    storedPath(u.db).superseded_by = uid();
    expect(await Outreach.reconcileSendError({ prospectId: u.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true });
    expect(placement(u.db).follow_up_status).toBe('sent');
  });
  test('P2: a CLOSED conversation does not shadow the next prospect (Codex r15): a row admitted for the released publisher is selected unbridged and decided; alone, the closed row still covers the slot', async () => {
    const s = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).ok).toBe(true);
    const until = addETDaysAtWallClock(new Date(placement(s.db).follow_up_sent_at), 45);
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ closed: 1 });
    expect(placement(s.db).conversation_closed_at).toBeTruthy();
    // Codex r18: the stored `acquiring` is CONTRADICTED by the closure (the conversation is no longer an active
    // intermediate) — selected stale ONCE, re-aggregated to qualified (the domain released: Reject / Watch usable)
    expect(s.db._tables.seo_link_domains[0].agent_state).toBe('acquiring');
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).toEqual([{ id: s.d.id, domain: 'example.org', why: 'stale' }]);
    expect(await nightly(s.db, { now: new Date(until.getTime() + DAY) })).toMatchObject({ aggregateChanges: 1, placementsCreated: 0 }); // no successor fabricated: a re-pitch is a NEW prospect the registry admits
    expect(s.db._tables.seo_link_prospects).toHaveLength(1);
    expect(s.db._tables.seo_link_domains[0].agent_state).toBe('qualified');
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent' }); // the closed row untouched
    // alone: the closed row's satisfied rows are the slot's history — nothing to bridge, no nightly slot spent
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).toEqual([]);
    // a fresh prospect for the released publisher, linked to the same best path (the registry catch-up): selected, decided
    const fresh = draftedRow(s.d, s.p, { id: uid(), target_page: '/mosquito/', outreach_status: 'none', outreach_subject: null, outreach_body: null, updated_at: until });
    s.db._tables.seo_link_prospects.push(fresh);
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).toEqual([{ id: s.d.id, domain: 'example.org', why: 'unbridged' }]);
    const r = await nightly(s.db, { now: new Date(until.getTime() + DAY) });
    expect(r.selected).toBe(1);
    expect(s.db._tables.seo_link_placement_authorities.some((x) => x.prospect_id === fresh.id && x.dimension === 'communication' && !x.ended_at)).toBe(true);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'sent' }); // the closed row untouched
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) })).toEqual([]); // converged
  });
  test('P2 (Codex r17): "It sent" on an ambiguous follow-up satisfies the instance the send was claimed under when only ANOTHER dimension was revised meanwhile; a communication revision after the draft is a later generation', async () => {
    const s = await conversation();
    const claim = await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER });
    expect(claim.ok).toBe(true);
    // rewind the finalize to the ambiguous state the reconcile settles, with the instance still open
    Object.assign(placement(s.db), { follow_up_status: 'send_error', follow_up_send_token: null, follow_up_sent_at: null });
    Object.assign(followUpRow(s.db), { satisfied_at: null, satisfied_reason: null });
    Object.assign(storedPath(s.db), { revision: 2, revision_payment: 2 }); // a payment-only change after the attempt: overall 2, communication still 1
    expect((await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).ok).toBe(true);
    expect(followUpRow(s.db)).toMatchObject({ satisfied_reason: 'sent' });
    const t = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: t.row.id, mode: 'auto', followUp: true, now: LATER })).ok).toBe(true);
    Object.assign(placement(t.db), { follow_up_status: 'send_error', follow_up_send_token: null, follow_up_sent_at: null });
    Object.assign(followUpRow(t.db), { satisfied_at: null, satisfied_reason: null, path_revision: 2 });
    Object.assign(storedPath(t.db), { revision: 2, revision_communication: 2 }); // the communication inputs changed: a later generation
    expect((await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'sent', approvedBy: 'Adam', followUp: true })).ok).toBe(true);
    expect(followUpRow(t.db).satisfied_at).toBeFalsy();
  });
  test('P2 (Codex r17): the owner SKIPS an unverifiable follow-up (routed on a marker) through the reconcile — terminal; a pitch, an unmarked draft or a sent follow-up cannot be skipped', async () => {
    const s = await conversation();
    gmail.getThread.mockRejectedValue(Object.assign(new Error('Requested entity was not found.'), { code: 404 }));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'reply_check_failed' });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_skipped_reason: 'reply_check_failed' });
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'skip', approvedBy: 'Adam' })).toMatchObject({ ok: false, code: 'bad_outcome' }); // a pitch is never skipped here
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/^skipped by Adam after review \(reply_check_failed\)/) });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: 'x', now: LATER })).toMatchObject({ ok: false, code: 'no_draft' });
    // an AUTO-decided drafted follow-up is the queue's to send, not skippable; a sent one is settled
    const t = await conversation();
    expect(await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: false, code: 'not_reconcilable' });
    Object.assign(placement(t.db), { follow_up_status: 'sent' });
    expect(await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: false, code: 'not_reconcilable' });
  });
  test('P2 (Codex r21): the authority gate turned OFF after a follow-up was scheduled (a redeploy): a due one retires at the lease, a drafted one on the owner\'s click or the reconcile\'s skip — never stranded until the gate returns', async () => {
    const due = await conversation({ decide: false });
    Object.assign(placement(due.db), { follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, follow_up_due_at: new Date(Date.now() - DAY) });
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    expect(placement(due.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    isEnabled.mockImplementation(() => true);
    const click = await conversation();
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    expect(await Outreach.sendOutreach({ prospectId: click.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(click.db)), now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    expect(placement(click.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    isEnabled.mockImplementation(() => true);
    const skip = await conversation();
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    expect(await Outreach.reconcileSendError({ prospectId: skip.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(skip.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/^skipped by Adam after review/) });
    isEnabled.mockImplementation(() => true);
  });
  test('P2 (Codex r22): with the authority gate OFF and the drafter off too, the closure sweep settles every pending follow-up (none / due / drafted, unleased) — no drafter, send or reconcile visit needed — and the conversation closes on the same run', async () => {
    const s = await conversation(); // drafted
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    const until = addETDaysAtWallClock(new Date(placement(s.db).outreach_sent_at), 45);
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ settled: 1, closed: 1 });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_due_at: null, follow_up_skipped_reason: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    expect(placement(s.db).conversation_closed_at).toBeTruthy();
    // a due one (never drafted) the same way
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, follow_up_due_at: new Date(Date.now() - DAY), conversation_closed_at: null, quality_signals: null });
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ settled: 1, closed: 1 });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/GATE_LINK_AUTHORITY/) });
    isEnabled.mockImplementation(() => true);
    expect(await Outreach.closeSilentConversations({ now: until })).not.toHaveProperty('settled'); // gate on: nothing settled here
  });
  test('P2 (Codex r22): a SECOND message of our own in the thread is a follow-up already sent by hand — the scheduled follow-up settles (skipped, manual_follow_up), nothing is sent: one follow-up ever', async () => {
    const s = await conversation();
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), ours('msg2')] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'follow_up_in_thread' });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'manual_follow_up' });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(approvals(s.db)).toHaveLength(0);
  });
  test('P2 (Codex r23): a Gmail DRAFT of ours in the thread is not a follow-up (never sent) — silence still proven, the follow-up goes out', async () => {
    const s = await conversation();
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), { ...ours('d1'), labelIds: ['DRAFT'] }] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: true });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'sent' });
  });
  test('P2 (Codex r23): the gate-off settlement touches SCHEDULED follow-ups only — a pre-migration send (`none`, no due date) is neither settled nor closed', async () => {
    const s = await conversation();
    Object.assign(placement(s.db), { follow_up_status: 'none', follow_up_due_at: null, follow_up_subject: null, follow_up_body: null }); // the migration default on a historical send
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    const until = addETDaysAtWallClock(new Date(placement(s.db).outreach_sent_at), 45);
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ settled: 0, scanned: 0, closed: 0 });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'none', conversation_closed_at: null });
    placement(s.db).follow_up_due_at = new Date(Date.now() - DAY); // scheduled: settled
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ settled: 1, closed: 1 });
    isEnabled.mockImplementation(() => true);
  });
  test('P2 (Codex r23): a DRAFTED follow-up whose path was deleted after the draft (FK SET NULL) retires on the send attempt — not a path_unlinked refusal that leaves it drafted forever', async () => {
    const s = await conversation();
    Object.assign(placement(s.db), { path_id: null });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'path_moved', error: expect.stringMatching(/deleted/) });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'acquisition path deleted before the follow-up' });
    const until = addETDaysAtWallClock(new Date(placement(s.db).outreach_sent_at), 45);
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ closed: 1 });
  });
  test('P1 (Codex r24): the DOMAIN guard holds a submit-first placement past its outcome while its follow-up is owed — no second placement for the publisher; released once the follow-up is sent / skipped; a send-first placed row never', async () => {
    const s = scenario({ policy: AUTO_POLICY, path: { execution_after_send: false, account_required: true } });
    await nightly(s.db);
    Object.assign(placement(s.db), { status: 'placed', parked_from_status: null, outreach_status: 'sent', outreach_sent_at: NOW, outreach_thread_ref: 'thr1', follow_up_status: 'none', follow_up_due_at: new Date(Date.now() - DAY), updated_at: NOW });
    expect((await claimProspectDomain(s.db, 'example.org')).inFlight?.id).toBe(s.row.id); // scheduled
    placement(s.db).follow_up_status = 'drafted';
    expect((await claimProspectDomain(s.db, 'example.org')).inFlight?.id).toBe(s.row.id); // drafted
    placement(s.db).follow_up_status = 'sent';
    expect((await claimProspectDomain(s.db, 'example.org')).inFlight).toBeNull(); // the lane complete: the domain is free again
    const t = scenario({ policy: AUTO_POLICY });
    await nightly(t.db);
    Object.assign(placement(t.db), { status: 'placed', parked_from_status: null, outreach_status: 'sent', outreach_sent_at: NOW, follow_up_status: 'none', follow_up_due_at: new Date(Date.now() - DAY) });
    expect((await claimProspectDomain(t.db, 'example.org')).inFlight).toBeNull(); // send-first: no follow-up past live
  });
  test('P2 (Codex r24): the hand-sent follow-up\'s Gmail time becomes the follow-up\'s send time — the closure window runs from it, not from the pitch', async () => {
    const s = await conversation();
    const manualAt = new Date(NOW.getTime() + 30 * DAY);
    gmail.getThread.mockResolvedValue({ id: 'thr1', messages: [ours('msg1'), { ...ours('msg2'), internalDate: String(manualAt.getTime()) }] });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'follow_up_in_thread' });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: 'manual_follow_up', follow_up_sent_at: manualAt });
    expect(await Outreach.closeSilentConversations({ now: addETDaysAtWallClock(NOW, 45) })).toMatchObject({ scanned: 0, closed: 0 }); // 45 days after the PITCH: not silent yet
    expect(await Outreach.closeSilentConversations({ now: addETDaysAtWallClock(manualAt, 45) })).toMatchObject({ closed: 1 });
  });
  test('P2 (Codex r24): the drafter\'s dry-run (preview) reads what the live claim would lease — a gate-off or re-ranked follow-up is not previewed', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, follow_up_due_at: new Date(Date.now() - DAY) });
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true, preview: true })).toHaveLength(1);
    s.db._tables.seo_link_domains[0].best_path_id = uid(); // re-ranked to another path
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true, preview: true })).toEqual([]);
    s.db._tables.seo_link_domains[0].best_path_id = s.p.id;
    isEnabled.mockImplementation((g) => g !== 'linkAuthority');
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true, preview: true })).toEqual([]);
    isEnabled.mockImplementation(() => true);
    expect(placement(s.db).follow_up_status).toBe('due'); // no retirement write from a preview
  });
  test('P1 (Codex r25): the DOMAIN guard holds a Judge-owned placement whose follow-up send is AMBIGUOUS (sending / send_error) — whatever the path', async () => {
    const t = scenario({ policy: AUTO_POLICY }); // send-first: no follow-up past live — but an ambiguous one may have been delivered
    await nightly(t.db);
    Object.assign(placement(t.db), { status: 'placed', parked_from_status: null, outreach_status: 'sent', outreach_sent_at: NOW, follow_up_status: 'send_error', follow_up_due_at: null });
    expect((await claimProspectDomain(t.db, 'example.org')).inFlight?.id).toBe(t.row.id);
    placement(t.db).follow_up_status = 'sending';
    expect((await claimProspectDomain(t.db, 'example.org')).inFlight?.id).toBe(t.row.id);
    placement(t.db).follow_up_status = 'skipped';
    expect((await claimProspectDomain(t.db, 'example.org')).inFlight).toBeNull();
  });
  test('P2 (Codex r25): a stale Skip on a follow-up the bridge re-decided AUTO meanwhile is refused under the lock', async () => {
    const s = await conversation();
    followUpRow(s.db).level = 'OWNER_OUTREACH';
    let reads = 0; // the pre-read passes the fast check; the bridge re-decides between it and the LOCKED row read
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects' && ++reads === 2) { db._tables.seo_link_placement_authorities.forEach((r) => { if (r.instance_kind === 'followup') r.level = 'AUTO_OUTREACH'; }); db._beforeResolve = null; } };
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: false, code: 'not_reconcilable' });
    expect(placement(s.db).follow_up_status).toBe('drafted');
  });
  test('P2 (Codex r25): a whitespace-only follow-up draft is refused (draft_incomplete), never parked for the review', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, follow_up_due_at: new Date(Date.now() - DAY) });
    const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: hi', outreach_body: '   \n\t ' })).toMatchObject({ ok: false, code: 'draft_incomplete' });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', follow_up_body: null });
  });
  test('P2 (Codex r25): a requeue after an OWNER follow-up\'s ambiguous attempt invalidates the click\'s approval — the card offers Send again', async () => {
    const s = await conversation({ followUpBody: `${FOLLOW_UP_BODY}\nWe would gladly link back to you.` }); // OWNER_OUTREACH (unclean copy)
    gmail.sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: M.followUpHash(placement(s.db)), now: LATER })).toMatchObject({ ok: false, code: 'send_failed' });
    expect(approvals(s.db)).toHaveLength(1);
    expect(approvals(s.db)[0].invalidated_at).toBeFalsy();
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true });
    expect(approvals(s.db)[0].invalidated_at).toBeTruthy();
    expect(placement(s.db).follow_up_status).toBe('drafted');
  });
  test('P2 (Codex r19): a SKIP of an ambiguous follow-up keeps the attempt stamp (Gmail may have delivered it — the ET-day cap counts every attempt); only a confirmed-not-sent requeue clears it', async () => {
    const s = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: NOW })).ok).toBe(true);
    Object.assign(placement(s.db), { follow_up_status: 'send_error', follow_up_send_token: null, follow_up_sent_at: null }); // the ambiguous outcome, the attempt stamped NOW
    expect(placement(s.db).follow_up_attempted_at).toEqual(NOW);
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_attempted_at: NOW });
    const t = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: t.row.id, mode: 'auto', followUp: true, now: NOW })).ok).toBe(true);
    Object.assign(placement(t.db), { follow_up_status: 'send_error', follow_up_send_token: null, follow_up_sent_at: null });
    expect(await Outreach.reconcileSendError({ prospectId: t.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true });
    expect(placement(t.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_attempted_at: null });
  });
  test('P2 (Codex r18): the owner SKIPS a follow-up the POLICY routed to them (OWNER_OUTREACH, no marker) — the Owner queue card\'s terminal action; the conversation then closes on silence', async () => {
    const s = await conversation();
    followUpRow(s.db).level = 'OWNER_OUTREACH'; // unclean copy / a score outside the automatic threshold: the owner's to send
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'drafted', follow_up_skipped_reason: null });
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'skip', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'skipped by Adam after review' });
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, approvedBy: 'Adam', mode: 'owner', followUp: true, draftHash: 'x', now: LATER })).toMatchObject({ ok: false, code: 'no_draft' });
    // the lane is complete (pitch sent, follow-up skipped): the closure sweep reads the silence and releases the inbox
    const until = addETDaysAtWallClock(new Date(placement(s.db).outreach_sent_at), 45);
    expect(await Outreach.closeSilentConversations({ now: until })).toMatchObject({ closed: 1 });
    expect(placement(s.db).conversation_closed_at).toBeTruthy();
  });
  test('P2 (Codex r16): the owner queue CLOSES an owner-routed follow-up whose thread recipient became a customer contact instead of showing an unusable card', async () => {
    const s = await conversation();
    followUpRow(s.db).level = 'OWNER_OUTREACH'; // owner-routed (a marker, or the policy)
    s.db._tables.customers.push({ id: 'c9', email: 'editor@example.org', service_contact_email: null, service_contact2_email: null, service_contact3_email: null });
    const row = (await Q.listOwnerQueue(s.db)).cards[0].rows.find((r) => r.instance_kind === 'followup');
    expect(row).toMatchObject({ approvable: false, why_not: expect.stringMatching(/follow-up is closed/) });
    expect(placement(s.db)).toMatchObject({ status: 'contacted', follow_up_status: 'skipped', follow_up_skipped_reason: 'customer_recipient' });
    await nightly(s.db, { now: new Date(LATER.getTime() + DAY) });
    expect(followUpRow(s.db)).toBeUndefined(); // the instance ends: nothing stranded
  });
  test('P2 (Codex r16): a follow-up whose path was DELETED (path_id NULL) is retired at the lease, not filtered out forever', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null, path_id: null });
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/deleted/) });
  });
  test('P2 (Codex r16): the domain RE-RANKED while the drafter held the lease — the drafted report retires the follow-up instead of parking a frozen draft', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    const [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    expect(l).toBeTruthy();
    const other = outreachPath(s.d); s.db._tables.seo_link_acquisition_paths.push(other); s.db._tables.seo_link_domains[0].best_path_id = other.id;
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'follow_up_obsolete', error: expect.stringMatching(/re-ranked/) });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/re-ranked/), claimed_at: null });
  });
  test('P2 (Codex r16): the nightly slice spends follow-up work BEFORE cold unbridged domains — a drafted follow-up awaiting its instance outranks an older unbridged domain', async () => {
    const s = await conversation({ decide: false }); // drafted follow-up, no communication/followup instance yet
    const d2 = domainRow({ domain: 'older-unbridged.org', updated_at: new Date(EARLIER.getTime() - DAY) }); const p2 = outreachPath(d2); d2.best_path_id = p2.id;
    s.db._tables.seo_link_domains.push(d2); s.db._tables.seo_link_acquisition_paths.push(p2);
    const picked = await selection.selectDomains(s.db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(0) });
    expect(picked.map((x) => [x.domain, x.why])).toEqual([['example.org', 'stale'], ['older-unbridged.org', 'unbridged']]);
    expect(await selection.selectDomains(s.db, { domainIds: null, limit: 1, policyUpdatedAt: new Date(0) })).toEqual([{ id: s.d.id, domain: 'example.org', why: 'stale' }]);
  });
  test('P2: the domain RE-RANKED to another standing path retires the follow-up — at the lease (due) and at the send (drafted): the pinned conversation is frozen off the best path', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    const other = outreachPath(s.d); s.db._tables.seo_link_acquisition_paths.push(other); s.db._tables.seo_link_domains[0].best_path_id = other.id;
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/re-ranked/), claimed_at: null });
    const t = await conversation();
    const other2 = outreachPath(t.d); t.db._tables.seo_link_acquisition_paths.push(other2); t.db._tables.seo_link_domains[0].best_path_id = other2.id;
    expect(await Outreach.sendOutreach({ prospectId: t.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'not_authorized', error: expect.stringMatching(/retired/) });
    expect(placement(t.db)).toMatchObject({ follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/re-ranked/) });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
  test('P2: a path SUPERSEDED during the ten-day wait retires the follow-up at the lease (skipped) — the pinned conversation completes instead of holding its inbox forever', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    storedPath(s.db).superseded_by = uid();
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true })).toEqual([]);
    expect(placement(s.db)).toMatchObject({ status: 'contacted', outreach_status: 'sent', follow_up_status: 'skipped', follow_up_skipped_reason: expect.stringMatching(/superseded/), claimed_at: null });
    // a preview writes nothing
    const t = await conversation({ decide: false });
    Object.assign(placement(t.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY) });
    storedPath(t.db).superseded_by = uid();
    expect(await worker.claim({ n: 10, type: 'outreach', followUp: true, preview: true })).toEqual([]);
    expect(placement(t.db).follow_up_status).toBe('due');
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
    expect((await claimProspectDomain(s.db, 'example.org')).inFlight?.id).toBe(s.row.id); // the domain is held while the conversation is open
    // a second placement addressed to the same editor: the inbox guard holds while the conversation is open
    const other = draftedRow(s.d, s.p, { target_page: '/mosquito/', outreach_to_email: 'Editor@Example.org' });
    s.db._tables.seo_link_prospects.push(other);
    const conflict = () => s.db.transaction((trx) => Outreach.inboxConflict(trx, { recipient: other.outreach_to_email, excludeId: other.id }));
    expect((await conflict()).id).toBe(s.row.id);
    gmail.getThread.mockClear(); // the follow-up send's reply check is not the sweep's read
    // not yet: the window is 45 ET calendar days from the LAST send (the follow-up's) at its ET wall-clock time — a minute short is not silent
    const until = addETDaysAtWallClock(sentAt, 45);
    expect(await Outreach.closeSilentConversations({ now: day(43) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(await Outreach.closeSilentConversations({ now: new Date(until.getTime() - 60000) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(gmail.getThread).not.toHaveBeenCalled();
    expect(await Outreach.closeSilentConversations({ now: until })).toEqual({ scanned: 1, closed: 1, open: 0, failed: 0 }); // the whole window elapsed at the send's wall-clock time: read, silent, closed
    expect(placement(s.db).conversation_closed_at).toEqual(until);
    Object.assign(placement(s.db), { conversation_closed_at: null, quality_signals: null }); // rewind the stamp for the reply / failure cases below
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
    expect((await claimProspectDomain(s.db, 'example.org')).inFlight?.id).not.toBe(s.row.id); // the domain admission guard releases the closed conversation too (Codex r6) — the second, still-open placement is the domain's next
    expect(s.db._raws.some((r) => /link_prospect_domain|advisory/i.test(String(r)))).toBe(true); // stamped under the per-domain lock
    // the thread is read UNDER the locks (the row cannot be reopened or hand-moved between the read and the stamp): the lock + FOR UPDATE precede the read
    const order = s.db._raws.map(String);
    expect(order.lastIndexOf('FOR UPDATE seo_link_prospects')).toBeGreaterThan(order.findIndex((r) => /link_prospect_domain|advisory/i.test(r)));
    expect(gmail.getThread.mock.invocationCallOrder[0]).toBeGreaterThan(0);
    // closed rows leave the candidate set — no second thread read
    gmail.getThread.mockClear();
    expect(await Outreach.closeSilentConversations({ now: day(60) })).toEqual({ scanned: 0, closed: 0, open: 0, failed: 0 });
    expect(gmail.getThread).not.toHaveBeenCalled();
  });
  test('r4 P1: the sweep rotates — a conversation left open (a reply, a failed read) goes to the back of the line, so `limit` never starves a newer silent one', async () => {
    const s = await conversation();
    expect((await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).ok).toBe(true);
    const a = placement(s.db);
    const b = { ...a, id: uid(), target_domain: 'other.example', target_page: '/', outreach_to_email: 'editor@other.example', outreach_thread_ref: 'thr-b', outreach_sent_at: new Date(new Date(a.outreach_sent_at).getTime() + 60000), follow_up_sent_at: new Date(new Date(a.follow_up_sent_at).getTime() + 60000), quality_signals: null, conversation_closed_at: null, notes: null };
    s.db._tables.seo_link_prospects.push(b);
    const at = new Date(addETDaysAtWallClock(new Date(b.follow_up_sent_at), 45).getTime() + DAY);
    gmail.getThread.mockReset();
    gmail.getThread.mockImplementation(async (ref) => (ref === 'thr1' ? { id: 'thr1', messages: [ours('m1'), theirs('Dana <dana@example.org>')] } : { id: ref, messages: [ours('m1')] }));
    // day 1, one read: A (the older send) — a reply, left open, stamped checked
    expect(await Outreach.closeSilentConversations({ now: at, limit: 1 })).toEqual({ scanned: 1, closed: 0, open: 1, failed: 0 });
    expect(gmail.getThread).toHaveBeenLastCalledWith('thr1');
    expect(a.quality_signals).toEqual({ closure_checked_at: at.toISOString() });
    expect(a.conversation_closed_at).toBeFalsy();
    // day 2, one read: B (never checked) goes first — silent, closed
    const at2 = new Date(at.getTime() + DAY);
    expect(await Outreach.closeSilentConversations({ now: at2, limit: 1 })).toEqual({ scanned: 1, closed: 1, open: 0, failed: 0 });
    expect(gmail.getThread).toHaveBeenLastCalledWith('thr-b');
    expect(s.db._tables.seo_link_prospects[1].conversation_closed_at).toEqual(at2);
    // day 3: A comes around again (still the owner's) — and a failed read rotates the same way
    gmail.getThread.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const at3 = new Date(at2.getTime() + DAY);
    expect(await Outreach.closeSilentConversations({ now: at3, limit: 1 })).toEqual({ scanned: 1, closed: 0, open: 0, failed: 1 });
    expect(a.quality_signals).toEqual({ closure_checked_at: at3.toISOString() });
  });
  test('r4 P2: a drafted follow-up on a send-first row the verifier promoted to live is no longer pending — the bridge ends its instance; a submit-first row keeps it; an ambiguous send stays pinned', async () => {
    const s = await conversation(); // the follow-up drafted and decided: an open communication/followup instance
    const fuRow = () => s.db._tables.seo_link_placement_authorities.find((r) => r.instance_kind === 'followup' && !r.ended_at);
    expect(fuRow()).toBeTruthy();
    expect(M.followUpPending(placement(s.db), storedPath(s.db))).toBe(true);
    Object.assign(placement(s.db), { status: 'live', live_url: 'https://example.org/resources/', updated_at: new Date(LATER.getTime() + 1000) }); // the verifier found the link
    expect(M.followUpPending(placement(s.db), storedPath(s.db))).toBe(false); // the sender refuses it by the same rule (FOLLOW_UP_STATUSES on a send-first path = contacted)
    expect(M.followUpPending(placement(s.db), { ...storedPath(s.db), execution_after_send: false, account_required: true })).toBe(true); // Judge-owned statuses follow up on a submit-first path (the acquire step exists AND precedes the pitch)
    expect(M.followUpPending({ ...placement(s.db), follow_up_status: 'sending' }, storedPath(s.db))).toBe(true); // pinned until the reconcile, whatever the lifecycle
    await nightly(s.db, { now: new Date(LATER.getTime() + 60000) });
    expect(fuRow()).toBeUndefined(); // ended: no longer required — no card on the live row, nothing stranded
  });
  test('r6 P2: a drafted follow-up reported on a row that left the follow-up lifecycle under the lease is discarded and the follow-up RETIRED; a domain parked meanwhile returns it to due', async () => {
    const s = await conversation({ decide: false });
    Object.assign(placement(s.db), { follow_up_status: 'due', follow_up_due_at: new Date(Date.now() - DAY), follow_up_subject: null, follow_up_body: null });
    let [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    // the owner's Watch landed under the lease: not claimable — the draft is discarded, the follow-up waits (due)
    s.db._tables.seo_link_domains[0].agent_state = 'watching';
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'not_eligible' });
    expect(placement(s.db)).toMatchObject({ follow_up_status: 'due', follow_up_subject: null, claimed_at: null });
    s.db._tables.seo_link_domains[0].agent_state = 'qualified';
    [l] = await worker.claim({ n: 10, type: 'outreach', followUp: true });
    // the verifier promoted the send-first row to live while the drafter worked: no follow-up applies — retired, never a stranded draft
    Object.assign(placement(s.db), { status: 'live', live_url: 'https://example.org/resources/' });
    expect(await worker.report({ prospect_id: s.row.id, outcome: 'drafted', lease_token: l.lease_token, outreach_subject: 'Re: A resource for your readers', outreach_body: FOLLOW_UP_BODY })).toMatchObject({ ok: false, code: 'follow_up_obsolete' });
    expect(placement(s.db)).toMatchObject({ status: 'live', follow_up_status: 'skipped', follow_up_subject: null, claimed_at: null });
    expect(placement(s.db).follow_up_skipped_reason).toMatch(/left the follow-up lifecycle \(live\)/);
    expect(M.followUpPending(placement(s.db), storedPath(s.db))).toBe(false);
  });
  test('r6 P2: a requeue of an ambiguous follow-up on a row that left the lifecycle RETIRES it (skipped, the UI told so) instead of parking an unsendable draft', async () => {
    const s = await conversation();
    gmail.sendMessage.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await Outreach.sendOutreach({ prospectId: s.row.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'send_failed' });
    // promoted between the reconcile's pre-read and its write (Codex r7): the decision is taken on the LOCKED row, so the promotion still retires it
    s.db._raws.length = 0;
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects' && db._raws.some((r) => /FOR UPDATE seo_link_prospects/.test(String(r)))) Object.assign(db._tables.seo_link_prospects[0], { status: 'live', live_url: 'https://example.org/resources/' }); };
    expect(await Outreach.reconcileSendError({ prospectId: s.row.id, outcome: 'requeue', approvedBy: 'Adam', followUp: true })).toMatchObject({ ok: true, retired: true });
    s.db._beforeResolve = null;
    expect(placement(s.db)).toMatchObject({ status: 'live', follow_up_status: 'skipped', follow_up_send_token: null, follow_up_attempted_at: null });
    expect(placement(s.db).notes).toMatch(/follow-up retired/);
    expect(Outreach.conversationOpen(placement(s.db), storedPath(s.db))).toBe(false); // nothing owed: the inbox is free
  });
  test('r6 P2: ONE attempt budget across both lanes — a follow-up batch that fills it (no cap refusal) leaves the pitches nothing this run', async () => {
    const d = domainRow();
    const p = outreachPath(d);
    const BATCH = 100; // AUTO_SEND_BATCH
    const prospects = [], auth = [];
    for (let i = 0; i < BATCH; i += 1) {
      const id = uid();
      prospects.push({ id, domain_id: d.id, path_id: p.id, leased_path_revision: 1, target_domain: `f${i}.example`, target_page: '/', location_key: '-', status: 'contacted', outreach_status: 'sent', outreach_sent_at: EARLIER, outreach_thread_ref: `t${i}`, follow_up_status: 'drafted', follow_up_subject: 'Re: x', follow_up_body: 'y', outreach_to_email: `e${i}@f${i}.example`, link_type: 'resource', claimed_at: null, updated_at: EARLIER });
      auth.push({ id: uid(), prospect_id: id, path_id: p.id, dimension: 'communication', instance_kind: 'followup', instance_key: 'followup:1', level: 'AUTO_OUTREACH', ended_at: null, satisfied_at: null, approval_id: null });
    }
    const pitch = draftedRow(d, p, { target_domain: 'pitch.example', outreach_to_email: 'ed@pitch.example' });
    auth.push({ id: uid(), prospect_id: pitch.id, path_id: p.id, dimension: 'communication', instance_kind: '-', instance_key: '-', level: 'AUTO_OUTREACH', ended_at: null, satisfied_at: null, approval_id: null });
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_prospects: [...prospects, pitch], seo_link_placement_authorities: auth });
    const send = jest.fn(async ({ followUp }) => (followUp ? { ok: false, code: 'reply_received' } : { ok: true })); // every follow-up refused without a cap refusal
    const out = await bridge.autoSendDecided(db, { send, now: NOW });
    expect(send).toHaveBeenCalledTimes(BATCH);
    expect(send.mock.calls.every((c) => c[0].followUp === true)).toBe(true); // the pitch waits for the next run
    expect(out).toMatchObject({ attempted: BATCH, sent: 0 });
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


test.each(['slot_reserved', 'submitting'])('a follow-up cannot clear an acquisition lease with a %s slot', async (outcome) => {
  const s = await conversation({ path: { acquisition_type: 'content_submission', submission_url: 'https://example.org/submit' }, policy: { ...AUTO_POLICY, auto_free_acquisition: true, auto_submission_daily_cap: 5, preferred_provider: 'deterministic_runner' } });
  const now = new Date();
  const lease = Object.assign(placement(s.db), { claimed_at: now, lease_token: now.toISOString(), leased_provider: 'deterministic_runner', lease_mode: 'acquire', leased_path_revision: 1 });
  const E = require('../services/seo/link-execution-authority');
  const authority = await E.authorize(s.db, lease, storedPath(s.db), 'deterministic_runner');
  expect(authority).toBeTruthy();
  expect(await E.reserveSlot(s.db, lease, storedPath(s.db), authority, lease.lease_token, now)).toBeTruthy();
  const attempt = s.db._tables.seo_link_attempts.find(a => a.prospect_id === lease.id);
  if (outcome === 'submitting') expect(await require('../services/seo/link-execution-authority').beginSubmission(s.db, { prospectId: lease.id, leaseToken: lease.lease_token, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } })).toBe(true);
  expect(attempt.outcome).toBe(outcome);
  expect(await Outreach.sendOutreach({ prospectId: lease.id, mode: 'auto', followUp: true, now: LATER })).toMatchObject({ ok: false, code: 'acquisition_in_progress' });
  expect(gmail.sendMessage).not.toHaveBeenCalled();
  expect(placement(s.db).claimed_at).toEqual(lease.claimed_at);
  expect(attempt.outcome).toBe(outcome);
  await worker.releaseClaims([{ id: lease.id, lease_token: lease.lease_token }]);
  expect(attempt.outcome).toBe(outcome === 'submitting' ? 'submit_ambiguous' : 'slot_released');
});
