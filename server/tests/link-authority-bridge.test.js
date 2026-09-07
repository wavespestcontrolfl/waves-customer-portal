/**
 * Backlink Manager v2 step 4 (PR 2a) — the nightly `link-authority` bridge.
 * In-memory knex-shaped store; the pure §6.3 decision is the real one.
 * Behavior pinned: gate/dryRun = selection only; placements per lane; one
 * authority row per required instance; OWNER_* parks (with the two deferrals);
 * DENY/INVALID stamp only; waiver honoured for its exact floors; stale rows
 * re-decided + approvals invalidated; satisfied rows untouched; released when
 * the policy loosens; Judge-owned statuses never moved; §3.1 aggregate; one
 * bell per run; idempotent re-runs.
 */
jest.mock('../services/seo/link-prospect-verifier', () => ({ reconcileOutreach: jest.fn(async () => ({ matched: 0, ambiguous: 0 })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { WAVES_LOCATIONS } = require('../config/locations');
const { canonicalProspectDomain } = require('../services/seo/prospect-domain-lock');
const P = require('../services/seo/link-authority-policy');
const bridge = require('../services/seo/link-authority-bridge');
const selection = require('../services/seo/link-authority-selection');

// In-memory knex-shaped store — shared with the owner-queue tests
const { makeDb, uid } = require("./helpers/link-authority-store");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = new Date('2026-09-03T07:35:00Z');
const EARLIER = new Date('2026-09-01T00:00:00Z');
const HASH = 'a'.repeat(64);
const policyRow = (over = {}) => ({ id: 1, ...P.normalizePolicyRow(null), updated_at: EARLIER, ...over });
const domainRow = (over = {}) => ({ id: uid(), domain: 'example.org', source: 'competitor_gap', agent_state: 'qualified', score: 75, spam_score: 2, best_path_id: null, updated_at: EARLIER, ...over });
const pathRow = (domain, over = {}) => ({
  id: uid(), domain_id: domain.id, acquisition_type: 'self_service_free', link_type: 'directory', submission_url: 'https://example.org/add',
  estimated_cost_cents: null, renewal_cost_cents: null, renewal_period: null, currency: 'unknown', fee_scope: null, merchant_binding: null,
  account_required: false, email_verification: false, payment_required: false, legal_attestation: false, legal_terms_hash: null,
  agent_completable: true, terms_accepted_by_send: false, execution_after_send: true, baseline: false, confidence: '0.80',
  expected_rel: 'dofollow', revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
  last_investigated_at: EARLIER, superseded_by: null, authority_last_decided: null, updated_at: EARLIER, ...over,
});
const outreachPath = (domain, over = {}) => pathRow(domain, { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, ...over });
const paidPath = (domain, over = {}) => pathRow(domain, {
  acquisition_type: 'paid_listing', payment_required: true, estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location',
  merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } }, ...over,
});

function scenario({ make = pathRow, domain: dOver = {}, path: pOver = {}, policy = {}, extra = {} } = {}) {
  const d = domainRow(dOver);
  const p = make(d, pOver);
  d.best_path_id = p.id;
  const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow(policy)], ...extra });
  return { db, d, p };
}
const run = (db, opts = {}) => bridge.runAuthorityBridge(db, { now: NOW, exclusive: (k, fn) => fn(), notify: opts.notify || jest.fn(), ...opts });
const placements = (db) => db._tables.seo_link_prospects;
const rows = (db) => db._tables.seo_link_placement_authorities;
const domainState = (db) => db._tables.seo_link_domains[0].agent_state;

beforeEach(() => { isEnabled.mockReturnValue(true); });

describe('gate / dryRun', () => {
  test('gate off ⇒ selection only, zero writes, no bell', async () => {
    isEnabled.mockReturnValue(false);
    const { db } = scenario();
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ gated: true, selected: 1, decided: 0, placementsCreated: 0 });
    expect(placements(db)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
  test('dryRun ⇒ counts only', async () => {
    const { db } = scenario();
    const r = await run(db, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, gated: false, selected: 1, decided: 0 });
    expect(placements(db)).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
  });
  test('a held lease is reported and nothing is written', async () => {
    const { db } = scenario();
    const send = jest.fn(async () => ({ ok: true }));
    const r = await run(db, { exclusive: async (key, fn) => key === 'backlink-scan' ? fn() : ({ skipped: true, reason: 'lease_held' }), autoSend: true, send });
    expect(r.skipped).toBe('lease_held');
    expect(placements(db)).toHaveLength(0);
    // the send sweep still ran (nothing to send here): the lease holder was a manual run with autoSend false
    expect(r.autoSend).toEqual({ attempted: 0, sent: 0, skipped: [] });
  });
});

describe('a qualified domain with a free signup-lane path', () => {
  test('one placement per GBP location, one execution row each, OWNER_FREE parks, one bell', async () => {
    const { db, d, p } = scenario();
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ selected: 1, decided: 1, placementsCreated: WAVES_LOCATIONS.length, rowsWritten: WAVES_LOCATIONS.length, parked: WAVES_LOCATIONS.length, errors: [] });
    const ps = placements(db);
    expect(ps.map((x) => x.location_key).sort()).toEqual(WAVES_LOCATIONS.map((l) => l.id).sort());
    for (const x of ps) {
      expect(x).toMatchObject({ target_domain: 'example.org', target_page: bridge.HOMEPAGE, target_url: 'https://example.org/add', domain_id: d.id, path_id: p.id, link_type: 'directory', source: 'competitor_gap', status: 'awaiting_owner', parked_from_status: 'prospect', authority: 'OWNER_FREE' });
      expect(x.payment_group_id).toBeUndefined(); // a free path has no purchase to key
    }
    const rs = rows(db);
    expect(rs).toHaveLength(WAVES_LOCATIONS.length);
    for (const x of rs) {
      expect(x).toMatchObject({ dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', path_revision: 1, floor_waiver_id: null, decided_at: NOW });
      expect(x.decision_inputs_hash).toBe(P.decisionInputsHash('execution', { path: p, domain: d, policy: P.normalizePolicyRow(null), score: 75, instanceKey: '-:1' }));
    }
    expect(db._tables.seo_link_acquisition_paths[0].authority_last_decided).toBe('OWNER_FREE');
    expect(domainState(db)).toBe('qualified'); // awaiting the owner
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toMatchObject({ bell: true, link: '/admin/seo', dedupeKey: 'link-authority:2026-09-03', refreshOnDedupe: true, metadata: { lane: 'link_authority', parked: WAVES_LOCATIONS.length, domains: ['example.org'] } });
  });
  test('auto_free_acquisition on ⇒ AUTO_FREE, stays prospect, domain ready_to_acquire, no bell', async () => {
    const { db } = scenario({ policy: { auto_free_acquisition: true } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r.parked).toBe(0);
    expect(placements(db).every((x) => x.status === 'prospect' && x.authority === 'AUTO_FREE')).toBe(true);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(notify).not.toHaveBeenCalled();
  });
  test('a second run is a no-op (idempotent)', async () => {
    const { db } = scenario();
    await run(db);
    const before = JSON.stringify([placements(db), rows(db)]);
    const r = await run(db);
    expect(r).toMatchObject({ selected: 0, decided: 0, placementsCreated: 0, rowsWritten: 0, redecided: 0, parked: 0, released: 0 }); // nothing moved ⇒ not even selected
    expect(JSON.stringify([placements(db), rows(db)])).toBe(before);
    const r2 = await run(db, { domainIds: [db._tables.seo_link_domains[0].id] }); // forced: re-decided, still a no-op
    expect(r2).toMatchObject({ selected: 1, decided: 1, placementsCreated: 0, rowsWritten: 0, redecided: 0, parked: 0, released: 0 });
    expect(JSON.stringify([placements(db), rows(db)])).toBe(before);
  });
});

describe('outreach-lane paths', () => {
  test('one unscoped placement; OWNER_OUTREACH with no draft stays prospect (the draft lease runs first); deferred payment never parks', async () => {
    const { db } = scenario({ make: outreachPath, path: { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ placementsCreated: 1, rowsWritten: 2, parked: 0 });
    const [pl] = placements(db);
    expect(pl).toMatchObject({ location_key: '-', status: 'prospect', authority: 'OWNER_PAYMENT' });
    expect(rows(db).map((x) => [x.dimension, x.level]).sort()).toEqual([['communication', 'OWNER_OUTREACH'], ['payment', 'OWNER_PAYMENT']]);
    expect(domainState(db)).toBe('qualified');
    expect(notify).not.toHaveBeenCalled();
  });
  test('with a draft present the send approval parks the placement', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'www.example.org', target_page: 'https://www.wavespestcontrol.com/', location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', outreach_status: 'drafted', link_type: 'resource', updated_at: EARLIER });
    const r = await run(db);
    expect(r).toMatchObject({ placementsCreated: 0, parked: 1 }); // the existing row is matched by canonical host + page variant
    expect(placements(db)[0].status).toBe('awaiting_owner');
  });
  test('an outreach conversation already in flight for the inbox is ADOPTED, never doubled (the shared board guard)', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const manual = { id: uid(), target_domain: 'example.org', target_page: 'https://www.wavespestcontrol.com/pest-control/', location_key: '-', domain_id: null, path_id: null, status: 'contacted', link_type: null, outreach_status: 'sent', source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(manual);
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, placementsCreated: 0, rowsWritten: 1, parked: 0 });
    expect(placements(db)).toHaveLength(1);
    expect(placements(db)[0]).toMatchObject({ id: manual.id, domain_id: d.id, path_id: p.id, link_type: 'resource', status: 'contacted', authority: 'OWNER_OUTREACH' });
    // the pitch already went out: the initial communication instance is satisfied from that evidence, never re-sent
    expect(rows(db)[0]).toMatchObject({ prospect_id: manual.id, dimension: 'communication', instance_key: '-:1', satisfied_at: NOW, satisfied_reason: 'sent' });
    expect(domainState(db)).toBe('acquiring');
    // bound to ANOTHER live path ⇒ that path's placement: a SENT conversation is pinned there (bridged in place, not re-selected); nothing is created
    const other = outreachPath(d);
    db._tables.seo_link_acquisition_paths.push(other);
    Object.assign(manual, { path_id: other.id });
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 1000);
    const r2 = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r2).toMatchObject({ selected: 0, errors: [] });
    const r3 = await run(db, { domainIds: [d.id], now: new Date(NOW.getTime() + 120000) }); // forced: the conversation sits on another page AND path — reported, never doubled
    expect(r3).toMatchObject({ placementsCreated: 0, errors: [{ domain: 'example.org', skipped: 'outreach conversation in flight on another path (contacted)' }] });
    expect(placements(db)).toHaveLength(1);
  });
  test('an ambiguous send (send_error / sending) is never parked — it stays in the reconciliation lifecycle; only a DRAFTED message is approval-ready', async () => {
    for (const outreach_status of ['send_error', 'sending']) {
      const { db, d, p } = scenario({ make: outreachPath });
      db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', outreach_status, link_type: 'resource', updated_at: EARLIER });
      const r = await run(db);
      expect([outreach_status, r.parked, placements(db)[0].status]).toEqual([outreach_status, 0, 'prospect']);
    }
  });
  test('a draft arriving on an owner-routed outreach placement re-selects the domain and parks it — and the run after converges', async () => {
    const { db, d } = scenario({ make: outreachPath });
    await run(db);
    expect([placements(db)[0].status, domainState(db)]).toEqual(['prospect', 'qualified']);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    // the draft lease reports a draft: only the placement moved
    Object.assign(placements(db)[0], { outreach_status: 'drafted', outreach_subject: 'Hi', updated_at: new Date(NOW.getTime() + 1000) });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ selected: 1, parked: 1 });
    expect(placements(db)[0].status).toBe('awaiting_owner');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('a fee the owner settles by hand at checkout (OWNER_MANUAL_PAYMENT — foreign currency) IS deferred on an outreach path: the conversation must open the checkout first', async () => {
    const { db } = scenario({ make: outreachPath, path: { payment_required: true, estimated_cost_cents: 20000, currency: 'foreign', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const r = await run(db);
    expect(rows(db).find((x) => x.dimension === 'payment').level).toBe('OWNER_MANUAL_PAYMENT');
    expect([r.parked, placements(db)[0].status, domainState(db)]).toEqual([0, 'prospect', 'qualified']);
  });
  test('a price the owner must enter (OWNER_INPUT_REQUIRED) on an outreach path is NOT deferred: it parks at once', async () => {
    const { db } = scenario({ make: outreachPath, path: { payment_required: true, estimated_cost_cents: null, currency: 'unknown', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const r = await run(db);
    expect(rows(db).find((x) => x.dimension === 'payment').level).toBe('OWNER_INPUT_REQUIRED');
    expect([r.parked, placements(db)[0].status]).toEqual([1, 'awaiting_owner']);
  });
  test('a DORMANT homepage row beside an ACTIVE conversation on another page: the conversation is adopted, the homepage row displaced — never a nightly standoff', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const conversation = { id: uid(), target_domain: 'example.org', target_page: 'https://www.wavespestcontrol.com/pest-control/', location_key: '-', domain_id: null, path_id: null, status: 'contacted', link_type: 'resource', outreach_status: 'sent', outreach_sent_at: EARLIER, source: 'manual', updated_at: EARLIER };
    const homepage = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: null, status: 'prospect', link_type: 'directory', source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(conversation, homepage);
    // the homepage row's stray open instance (a historical decision) is displaced with it
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: homepage.id, path_id: p.id, dimension: 'communication', instance_kind: '-', instance_key: '-:1', level: 'OWNER_OUTREACH', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'sent' });
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, placementsCreated: 0, ended: 1, rowsWritten: 1, errors: [] });
    expect(placements(db).find((x) => x.id === conversation.id)).toMatchObject({ domain_id: d.id, path_id: p.id, status: 'contacted' });
    expect(placements(db).find((x) => x.id === homepage.id)).toMatchObject({ path_id: null, status: 'prospect' });
    expect(rows(db).filter((x) => x.prospect_id === homepage.id).map((x) => x.end_outcome)).toEqual(['superseded']);
    expect(rows(db).find((x) => x.prospect_id === conversation.id)).toMatchObject({ dimension: 'communication', satisfied_reason: 'sent' });
    expect(domainState(db)).toBe('acquiring');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // converged
    // the next run finds the bridged conversation FIRST whatever order the inbox lock returns the two `prospect`-class rows in
    db._tables.seo_link_prospects.reverse();
    Object.assign(db._tables.seo_link_policy[0], { updated_at: new Date(NOW.getTime() + 1000) });
    const again = await run(db, { now: new Date(NOW.getTime() + 60000), domainIds: [d.id] });
    expect(again).toMatchObject({ decided: 1, rowsWritten: 0, ended: 0, errors: [] });
    expect(rows(db).filter((x) => !x.ended_at).map((x) => x.prospect_id)).toEqual([conversation.id]);
  });
  test('a PINNED or LEASED homepage row beside an active conversation on another page is a real conflict: skipped, nothing adopted', async () => {
    const { db } = scenario({ make: outreachPath });
    const conversation = { id: uid(), target_domain: 'example.org', target_page: 'https://www.wavespestcontrol.com/pest-control/', location_key: '-', domain_id: null, path_id: null, status: 'contacted', link_type: 'resource', outreach_status: 'sent', source: 'manual', updated_at: EARLIER };
    const homepage = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: null, path_id: null, status: 'prospect', link_type: 'resource', outreach_status: 'sending', source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(conversation, homepage);
    const r = await run(db);
    expect(r.errors).toEqual([{ domain: 'example.org', skipped: 'outreach conversation in flight on another page (contacted)' }]);
    expect(placements(db).every((x) => !x.path_id)).toBe(true);
    expect(rows(db)).toHaveLength(0);
  });
  test('the display stamp never overwrites a placement timestamp written under it (a draft reported mid-run stays visible to selection)', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const reportedAt = new Date(NOW.getTime() + 5000); // the draft lease reported AFTER this run's `now`
    db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', outreach_status: 'none', link_type: 'resource', updated_at: reportedAt });
    await run(db);
    expect(placements(db)[0]).toMatchObject({ authority: 'OWNER_OUTREACH', updated_at: reportedAt });
    // …so the next night sees the row as stale and parks the (now drafted) placement
    Object.assign(placements(db)[0], { outreach_status: 'drafted' });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
  });
  test('an exact homepage outreach row left UNBOUND by the manual endpoint is adopted, never stuck behind a null path', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    // created under a signup lane with a stale classification and an unsent draft: the lane, URL, classification and draft follow the outreach path (the registry move patch)
    const manual = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: null, path_id: null, status: 'prospect', link_type: 'directory', target_url: 'https://example.org/add', automation_policy: 'auto', last_classified_at: EARLIER, outreach_status: 'drafted', outreach_subject: 'old', outreach_send_token: 'tok', source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(manual);
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, placementsCreated: 0, rowsWritten: 1, skippedLeased: 0, errors: [] });
    expect(placements(db)).toHaveLength(1);
    expect(placements(db)[0]).toMatchObject({ id: manual.id, domain_id: d.id, path_id: p.id, link_type: 'resource', target_url: null, automation_policy: null, last_classified_at: null, outreach_status: 'none', outreach_subject: null, outreach_send_token: null, authority: 'OWNER_OUTREACH' });
    expect(rows(db)[0]).toMatchObject({ prospect_id: manual.id, path_id: p.id, dimension: 'communication' });
  });
  test('an unbound manual row advanced to contacted BY HAND (no outreach markers) is adopted with its send satisfied — the worker could never satisfy it', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const manual = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: null, path_id: null, status: 'contacted', link_type: 'resource', outreach_status: null, outreach_sent_at: null, source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(manual);
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, placementsCreated: 0, rowsWritten: 1, parked: 0, errors: [] });
    expect(placements(db)[0]).toMatchObject({ id: manual.id, domain_id: d.id, path_id: p.id, status: 'contacted' });
    expect(rows(db)[0]).toMatchObject({ prospect_id: manual.id, dimension: 'communication', instance_key: '-:1', satisfied_at: NOW, satisfied_reason: 'sent' });
    expect(domainState(db)).toBe('acquiring'); // the conversation is in flight, not owner-held
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('a CONSUMED approval on a still-unsatisfied row is spent: the nightly re-parks the placement instead of releasing it again', async () => {
    const { db, p } = scenario({ make: paidPath });
    await run(db);
    const fee = rows(db).find((x) => x.dimension === 'payment');
    const approval = { id: uid(), prospect_id: fee.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_PAYMENT', dimension: 'payment', instance_key: '-:1', invalidated_at: null, consumed_at: null };
    db._tables.seo_link_approvals.push(approval);
    fee.approval_id = approval.id;
    for (const r of rows(db).filter((x) => x.prospect_id === fee.prospect_id && x.dimension !== 'payment')) Object.assign(r, { satisfied_at: NOW, satisfied_reason: 'human_step_done' });
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 1000);
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    const placement = placements(db).find((x) => x.id === fee.prospect_id);
    expect(placement.status).toBe('prospect'); // released under the live approval
    // the runner charged and reported a failed placement: the approval is consumed, the row stays unsatisfied
    approval.consumed_at = new Date(NOW.getTime() + 120000);
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 130000);
    const again = await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(again.released).toBe(0);
    expect(placements(db).find((x) => x.id === fee.prospect_id).status).toBe('awaiting_owner'); // parked for a fresh approval
    expect(approval.invalidated_at).toBeNull(); // spent, not invalidated — the audit trail keeps it
    // …and on a SATISFIED row the consumed approval is the durable prerequisite: nothing re-parks
    Object.assign(fee, { satisfied_at: new Date(NOW.getTime() + 200000), satisfied_reason: 'charged' });
    placements(db).find((x) => x.id === fee.prospect_id).status = 'prospect';
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 210000);
    const settled = await run(db, { now: new Date(NOW.getTime() + 240000) });
    expect(settled.parked).toBe(0);
  });

  test('an approved send with the fee DEFERRED to checkout reads ready_to_acquire — the deferred payment row holds nothing back', async () => {
    const { db, p } = scenario({ make: outreachPath, path: { payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    await run(db);
    expect(domainState(db)).toBe('qualified');
    const send = rows(db).find((x) => x.dimension === 'communication');
    const approval = { id: uid(), prospect_id: send.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_OUTREACH', dimension: 'communication', instance_key: '-:1', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    send.approval_id = approval.id;
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 1000);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.parked).toBe(0);
    const fee = rows(db).find((x) => x.dimension === 'payment');
    expect([fee.level, fee.approval_id || null, fee.satisfied_at || null]).toEqual(['OWNER_PAYMENT', null, null]); // still pending, still deferred
    expect(domainState(db)).toBe('ready_to_acquire');
  });
  test('legal attestation adds the accept_terms execution instance at OWNER_LEGAL', async () => {
    const { db } = scenario({ make: outreachPath, path: { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, legal_attestation: true, legal_terms_hash: HASH } });
    await run(db);
    expect(rows(db).map((x) => [x.dimension, x.instance_kind, x.instance_key, x.level]).sort()).toEqual([['communication', '-', '-:1', 'OWNER_LEGAL'], ['execution', 'terms', 'terms:1', 'OWNER_LEGAL']]);
  });
});

describe('floors and waivers', () => {
  test('DENY stamps every row and the placement, parks nothing, and rejects the domain', async () => {
    const { db } = scenario({ domain: { spam_score: 30 } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r.parked).toBe(0);
    expect(rows(db).every((x) => x.level === 'DENY' && /spam_score 30 > 10/.test(x.reason))).toBe(true);
    expect(placements(db).every((x) => x.status === 'prospect' && x.authority === 'DENY')).toBe(true);
    expect(domainState(db)).toBe('rejected');
    expect(notify).not.toHaveBeenCalled();
  });
  test('a rejection the bridge wrote itself lifts once the inputs improve — the owner\'s Reject on non-DENY rows stands', async () => {
    const { db } = scenario({ domain: { spam_score: 30 } });
    await run(db);
    expect(domainState(db)).toBe('rejected');
    // the enrichment improves (a re-scan): the DENY rows are stale and re-decided, and the aggregate follows
    Object.assign(db._tables.seo_link_domains[0], { spam_score: 2, updated_at: new Date(NOW.getTime() + 1000) });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ redecided: WAVES_LOCATIONS.length, parked: WAVES_LOCATIONS.length, aggregateChanges: 1, errors: [] });
    expect(rows(db).every((x) => x.level === 'OWNER_FREE')).toBe(true);
    expect(domainState(db)).toBe('qualified');
    // the owner's registry Reject on a domain the bridge holds at qualified (OWNER_* rows, not DENY) carries no bridge signature
    Object.assign(db._tables.seo_link_domains[0], { agent_state: 'rejected', updated_at: new Date(NOW.getTime() + 120000) });
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: true, updated_at: new Date(NOW.getTime() + 130000) });
    const r2 = await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(r2.redecided).toBe(WAVES_LOCATIONS.length);
    expect(rows(db).every((x) => x.level === 'AUTO_FREE')).toBe(true);
    expect(domainState(db)).toBe('rejected'); // the owner's ruling stands until Acquire anyway (a waiver)
  });
  test('the owner\'s Reject on a domain the bridge had already rejected stands — the marker, not the DENY signature, decides recovery', async () => {
    const { db } = scenario({ domain: { spam_score: 30 } });
    await run(db);
    expect(db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'rejected', rejected_by: 'bridge' });
    Object.assign(db._tables.seo_link_domains[0], { rejected_by: 'owner', spam_score: 2, updated_at: new Date(NOW.getTime() + 1000) }); // the registry Reject, then a re-scan
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ redecided: WAVES_LOCATIONS.length, aggregateChanges: 0 });
    expect(db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'rejected', rejected_by: 'owner' });
  });
  test('INVALID (unenriched) stamps and sends the domain back to investigating', async () => {
    const { db } = scenario({ domain: { spam_score: null } });
    await run(db);
    expect(rows(db).every((x) => x.level === 'INVALID')).toBe(true);
    expect(domainState(db)).toBe('investigating');
  });
  test('a valid waiver passes the floors: the UNDERLYING level is stamped with floor_waiver_id; a stale waiver is invalidated', async () => {
    const { db, d, p } = scenario({ domain: { spam_score: 30 } });
    const policy = P.normalizePolicyRow(null);
    const waiver = { id: uid(), domain_id: d.id, path_id: p.id, decision_inputs_hash: P.floorInputsHash({ path: p, domain: d, policy, score: 75 }), overridden_floors: [], approved_by: 'adam', approved_at: EARLIER, invalidated_at: null };
    db._tables.seo_link_floor_waivers.push(waiver);
    const r = await run(db);
    expect(r.parked).toBe(WAVES_LOCATIONS.length);
    expect(rows(db).every((x) => x.level === 'OWNER_FREE' && x.floor_waiver_id === waiver.id && /floors waived/.test(x.reason))).toBe(true);
    // spam rises further ⇒ the waiver no longer matches the floors the owner looked at
    db._tables.seo_link_domains[0].spam_score = 40;
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 500); // enrichment landed after the decision
    const r2 = await run(db, { now: new Date(NOW.getTime() + 1000) });
    expect(r2.invalidatedWaivers).toBe(1);
    expect(db._tables.seo_link_floor_waivers[0].invalidated_at).toBeTruthy();
    expect(rows(db).every((x) => x.level === 'DENY' && x.floor_waiver_id === null)).toBe(true);
    expect(placements(db).every((x) => x.status === 'prospect' && x.parked_from_status === null)).toBe(true); // released: nothing owner-gated any more
  });
});

describe('re-decision', () => {
  test('a stale row (policy changed since decided_at) is re-decided; a loosened policy releases the park; an attached approval whose inputs moved is invalidated', async () => {
    const { db, d, p } = scenario();
    await run(db);
    expect(placements(db).every((x) => x.status === 'awaiting_owner')).toBe(true);
    // an owner approval attached to one row (PR 2b writes these)
    const target = rows(db)[0];
    const approval = { id: uid(), prospect_id: target.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_FREE', dimension: 'execution', instance_key: '-:1', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    target.approval_id = approval.id;
    // the owner flips auto_free on
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: true, updated_at: new Date(NOW.getTime() + 1000) });
    const later = new Date(NOW.getTime() + 60000);
    const r = await run(db, { now: later });
    expect(r).toMatchObject({ selected: 1, redecided: WAVES_LOCATIONS.length, released: WAVES_LOCATIONS.length, invalidatedApprovals: 1, parked: 0 });
    expect(rows(db).every((x) => x.level === 'AUTO_FREE' && x.decided_at === later && x.approval_id == null)).toBe(true);
    expect(db._tables.seo_link_approvals[0]).toMatchObject({ invalidated_at: later });
    expect(placements(db).every((x) => x.status === 'prospect' && x.parked_from_status === null && x.authority === 'AUTO_FREE')).toBe(true);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(d.id).toBeTruthy();
  });
  test('a communication instance whose send is in flight is PINNED at the claimed authority: a concurrent run never rewrites it (the reconcile settles it)', async () => {
    const { db } = scenario({ make: outreachPath });
    await run(db);
    const [pl] = placements(db);
    const comm = rows(db).find((x) => x.prospect_id === pl.id && x.dimension === 'communication');
    expect(comm).toBeTruthy();
    for (const outreach_status of ['sending', 'send_error']) {
      // the claim granted AUTO_OUTREACH and took the draft (no longer `drafted`): a re-review here would read it unclean
      Object.assign(comm, { level: 'AUTO_OUTREACH', decided_at: EARLIER, approval_id: null });
      Object.assign(pl, { status: 'prospect', parked_from_status: null, outreach_status, outreach_subject: null, outreach_body: null, updated_at: new Date(NOW.getTime() + 1000) });
      Object.assign(db._tables.seo_link_policy[0], { updated_at: new Date(NOW.getTime() + 2000) });
      await run(db, { now: new Date(NOW.getTime() + 60000) });
      const after = rows(db).find((x) => x.id === comm.id);
      expect(after).toMatchObject({ level: 'AUTO_OUTREACH', decided_at: EARLIER });
      expect(after.ended_at).toBeFalsy();
      expect(placements(db).find((x) => x.id === pl.id)).toMatchObject({ status: 'prospect', outreach_status });
    }
  });
  test('a stale row is selected through the stale scan even when the domain is no longer qualified', async () => {
    const { db } = scenario({ policy: { auto_free_acquisition: true } });
    await run(db);
    expect(domainState(db)).toBe('ready_to_acquire');
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: false, updated_at: new Date(NOW.getTime() + 1000) });
    const later = new Date(NOW.getTime() + 60000);
    const r = await run(db, { now: later });
    expect(r).toMatchObject({ selected: 1, redecided: WAVES_LOCATIONS.length, parked: WAVES_LOCATIONS.length });
    expect(domainState(db)).toBe('qualified'); // a tightened policy re-parks
  });
  test('a satisfied instance is never re-decided; Judge-owned statuses are never moved; the domain reads acquired', async () => {
    const { db } = scenario();
    await run(db);
    const [pl] = placements(db);
    Object.assign(pl, { status: 'live' });
    const row = rows(db).find((x) => x.prospect_id === pl.id);
    Object.assign(row, { satisfied_at: NOW, satisfied_reason: 'placed', level: 'OWNER_FREE' });
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: true, updated_at: new Date(NOW.getTime() + 1000) });
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(rows(db).find((x) => x.id === row.id).level).toBe('OWNER_FREE');
    expect(placements(db).find((x) => x.id === pl.id).status).toBe('live');
    // the remaining siblings are AUTO_FREE + prospect ⇒ authorized-pending wins over acquired (§3.1)
    expect(domainState(db)).toBe('ready_to_acquire');
    for (const x of placements(db)) if (x.id !== pl.id) Object.assign(x, { status: 'rejected' });
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 120000);
    await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(domainState(db)).toBe('acquired');
  });
  test('the verifier demoting the last live link to LOST re-selects the acquired domain once and converges; a live-check touch alone does not', async () => {
    const { db, d } = scenario();
    await run(db);
    const [pl, ...others] = placements(db);
    Object.assign(pl, { status: 'live' });
    for (const r of rows(db)) Object.assign(r, { satisfied_at: NOW, satisfied_reason: 'placed' });
    for (const x of others) Object.assign(x, { status: 'rejected' });
    await run(db, { domainIds: [d.id], now: new Date(NOW.getTime() + 60000) }); // forced: every row is satisfied, nothing else would revisit
    expect(domainState(db)).toBe('acquired');
    // the nightly live check touches updated_at on a link that is still live: nothing to revisit
    Object.assign(pl, { last_live_check: new Date(NOW.getTime() + 120000), updated_at: new Date(NOW.getTime() + 120000) });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    // the definitive crawl loses the link (link-prospect-verifier: status → lost, rows untouched)
    Object.assign(pl, { status: 'lost', updated_at: new Date(NOW.getTime() + 180000) });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 240000) });
    expect(r).toMatchObject({ selected: 1, aggregateChanges: 1, redecided: 0, ended: 0, errors: [] }); // the satisfied history stands
    expect(domainState(db)).toBe('qualified'); // no link, nothing active, nothing owner-held
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // converged
  });
  test('the verifier promoting placed → live re-selects the acquiring domain once and converges to acquired; a touch alone does not', async () => {
    const { db, d } = scenario();
    await run(db);
    const [pl, ...others] = placements(db);
    Object.assign(pl, { status: 'placed' });
    for (const r of rows(db)) Object.assign(r, { satisfied_at: NOW, satisfied_reason: 'placed' });
    for (const x of others) Object.assign(x, { status: 'rejected' });
    await run(db, { domainIds: [d.id], now: new Date(NOW.getTime() + 60000) });
    expect(domainState(db)).toBe('acquiring'); // placed is an active intermediate
    Object.assign(pl, { updated_at: new Date(NOW.getTime() + 120000) }); // a touch while still placed
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    Object.assign(pl, { status: 'live', updated_at: new Date(NOW.getTime() + 180000) }); // link-prospect-verifier markLive: status only
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 240000) });
    expect(r).toMatchObject({ selected: 1, aggregateChanges: 1, redecided: 0, ended: 0, errors: [] });
    expect(domainState(db)).toBe('acquired');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // converged
  });
  test('the advisory domain lock is taken BEFORE the domain row lock (one lock order with lost-link recovery)', async () => {
    const { db } = scenario();
    await run(db);
    const advisory = db._raws.findIndex((x) => /pg_advisory_xact_lock/.test(x));
    const rowLock = db._raws.findIndex((x) => x === 'FOR UPDATE seo_link_domains');
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(rowLock).toBeGreaterThan(advisory);
  });
  test('a route the investigator disproved (best_path_id cleared) retires the open instances, invalidates their approvals and sends the domain back to investigating', async () => {
    const { db, d, p } = scenario();
    await run(db);
    const row = rows(db)[0];
    const approval = { id: uid(), prospect_id: row.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_FREE', dimension: 'execution', instance_key: row.instance_key, invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    row.approval_id = approval.id;
    Object.assign(db._tables.seo_link_domains[0], { best_path_id: null, updated_at: new Date(NOW.getTime() + 1000) }); // disproveGonePaths
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ decided: 1, ended: WAVES_LOCATIONS.length, invalidatedApprovals: 1, aggregateChanges: 1, placementsCreated: 0, errors: [] });
    expect(rows(db).every((x) => x.ended_at && x.end_outcome === 'superseded')).toBe(true);
    expect(approval.invalidated_at).toBeTruthy();
    expect(domainState(db)).toBe('investigating');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // converged
  });
  test('a PAID signup domain whose route is cleared (best_path_id null) is not held by the lane-shape hold: its open execution instance is retired and it returns to investigating', async () => {
    const { db, d } = scenario({ make: paidPath, policy: { max_auto_purchase_cents: 10000, monthly_paid_budget_cents: 100000 } });
    await run(db);
    const paid = rows(db).filter((x) => x.dimension === 'payment');
    for (const x of paid) Object.assign(x, { satisfied_at: NOW, satisfied_reason: 'charged' }); // the checkout succeeded…
    expect(rows(db).filter((x) => x.dimension === 'execution' && !x.satisfied_at)).toHaveLength(WAVES_LOCATIONS.length); // …the submit is still owed
    Object.assign(db._tables.seo_link_domains[0], { best_path_id: null, updated_at: new Date(NOW.getTime() + 1000) }); // disproveGonePaths
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ decided: 1, ended: WAVES_LOCATIONS.length, aggregateChanges: 1, errors: [] });
    expect(rows(db).filter((x) => x.dimension === 'execution').every((x) => x.end_outcome === 'superseded')).toBe(true);
    expect(rows(db).filter((x) => x.dimension === 'payment').every((x) => !x.ended_at)).toBe(true); // the paid proof is history, kept open
    expect(domainState(db)).toBe('investigating');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('a settled payment on a placement outside the lane shape HOLDS the domain: suppressed in selection, refused by a forced run before any in-shape row is reused or created', async () => {
    const { db, d, p } = scenario({ make: outreachPath, path: { payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const old = paidPath(d);
    db._tables.seo_link_acquisition_paths.push(old);
    const paid = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: old.id, status: 'live', link_type: 'directory', updated_at: EARLIER };
    paid.payment_group_id = paid.id;
    // a historical in-shape outreach row the bridge would otherwise REUSE (and open a fresh payment instance on)
    const historical = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', link_type: 'resource', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(paid, historical);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: paid.id, path_id: old.id, dimension: 'payment', instance_kind: '-', instance_key: '-:1', level: 'OWNER_PAYMENT', decision_inputs_hash: 'x', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'charged' });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // held: no nightly slot
    const r = await run(db, { domainIds: [d.id] });
    expect(r).toMatchObject({ selected: 1, decided: 0, placementsCreated: 0, rowsWritten: 0, parked: 0 });
    expect(r.errors).toEqual([{ domain: 'example.org', skipped: expect.stringMatching(/settled payment on a placement outside the lane shape/) }]);
    expect(rows(db)).toHaveLength(1); // the proof alone — nothing opened on the historical row
  });
  test('a fully settled account-wide group whose fee_scope flips to per_location is HELD (never selected, keys untouched); unpaid it is stale and regroups', async () => {
    const { db } = scenario({ make: paidPath, path: { fee_scope: 'account_wide' } });
    await run(db);
    expect(new Set(placements(db).map((x) => x.payment_group_id)).size).toBe(1);
    const stored = db._tables.seo_link_acquisition_paths[0];
    Object.assign(stored, { fee_scope: 'per_location', revision_payment: 2, updated_at: new Date(NOW.getTime() + 1000) });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']); // unpaid: automatic regroup
    for (const r of rows(db).filter((x) => x.dimension === 'payment')) Object.assign(r, { satisfied_at: NOW, satisfied_reason: 'group_purchase' });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // paid: held for the owner's regroup
    const r = await run(db, { domainIds: [db._tables.seo_link_domains[0].id], now: new Date(NOW.getTime() + 60000) });
    expect(r.errors).toEqual([]);
    expect(new Set(placements(db).map((x) => x.payment_group_id)).size).toBe(1); // a forced run refuses the regroup too
  });
  test('a worker that claimed and reported a ready_to_acquire placement moves it past prospect: the domain re-aggregates to acquiring', async () => {
    const { db, d } = scenario({ policy: { auto_free_acquisition: true } });
    await run(db);
    expect(domainState(db)).toBe('ready_to_acquire');
    for (const x of placements(db)) Object.assign(x, { status: 'placed', updated_at: new Date(NOW.getTime() + 1000) });
    for (const r of rows(db)) Object.assign(r, { satisfied_at: new Date(NOW.getTime() + 1000), satisfied_reason: 'placed' });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ aggregateChanges: 1, redecided: 0, errors: [] });
    expect(domainState(db)).toBe('acquiring');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('on a submit-first outreach path (execution_after_send=false) placed/live prove the submit only — the late send stays owed; submit-after-send paths still count them', async () => {
    for (const [after, satisfied] of [[false, false], [true, true]]) {
      const { db } = scenario({ make: outreachPath, path: { account_required: true, execution_after_send: after } });
      const manual = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: null, path_id: null, status: 'placed', link_type: 'resource', outreach_status: null, outreach_sent_at: null, source: 'manual', updated_at: EARLIER };
      db._tables.seo_link_prospects.push(manual);
      await run(db);
      const send = rows(db).find((x) => x.dimension === 'communication');
      expect(Boolean(send.satisfied_at)).toBe(satisfied);
    }
  });
  test('the publisher step on a SEND-FIRST outreach path (execution_after_send=true) never parks the prospect before its draft: the send comes first; submit-first parks at once', async () => {
    for (const [after, parked, status, state] of [[true, 0, 'prospect', 'qualified'], [false, 1, 'awaiting_owner', 'qualified']]) {
      const { db } = scenario({ make: outreachPath, path: { account_required: true, agent_completable: false, execution_after_send: after } });
      const r = await run(db);
      expect(rows(db).find((x) => x.dimension === 'execution').level).toBe('OWNER_HUMAN_STEP');
      expect([r.parked, placements(db)[0].status, domainState(db)]).toEqual([parked, status, state]);
    }
    // with the pitch approved, a send-first domain is ready_to_acquire — the human step waits for the contacted row
    const { db } = scenario({ make: outreachPath, path: { account_required: true, agent_completable: false, execution_after_send: true } });
    await run(db);
    const send = rows(db).find((x) => x.dimension === 'communication');
    const approval = { id: uid(), decision: 'approved', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    Object.assign(send, { approval_id: approval.id });
    Object.assign(db._tables.seo_link_policy[0], { updated_at: new Date(NOW.getTime() + 1000) });
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(domainState(db)).toBe('ready_to_acquire');
  });
  test('adopting a durably SENT row still at prospect advances it to contacted (the sender refuses it, a paid checkout claims only from contacted)', async () => {
    const { db } = scenario({ make: outreachPath });
    const manual = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: null, path_id: null, status: 'prospect', link_type: 'resource', outreach_status: 'sent', outreach_sent_at: EARLIER, source: 'manual', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(manual);
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, parked: 0, errors: [] });
    expect(placements(db)[0]).toMatchObject({ id: manual.id, status: 'contacted' });
    expect(rows(db)[0]).toMatchObject({ dimension: 'communication', satisfied_reason: 'sent' });
    expect(domainState(db)).toBe('acquiring');
  });
  test('a fee_scope change after payment activity never regroups: the keys stay, the unsatisfied payment instances park OWNER_INPUT_REQUIRED; without activity the regroup is automatic', async () => {
    const { db } = scenario({ make: paidPath }); // per_location: each placement its own group
    const stored = db._tables.seo_link_acquisition_paths[0];
    await run(db);
    const before = placements(db).map((x) => [x.id, x.payment_group_id]);
    expect(before.every(([id, g]) => g === id)).toBe(true);
    // account_wide with no purchase anywhere: automatic regroup onto the first placement's id
    Object.assign(stored, { fee_scope: 'account_wide', revision_payment: 2, updated_at: new Date(NOW.getTime() + 1000) });
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(new Set(placements(db).map((x) => x.payment_group_id)).size).toBe(1);
    // money left on one placement, then the scope flips back: NOT applied — keys untouched, the rest park for the owner's regroup
    const charged = rows(db).find((x) => x.dimension === 'payment');
    Object.assign(charged, { satisfied_at: NOW, satisfied_reason: 'charged' });
    Object.assign(stored, { fee_scope: 'per_location', revision_payment: 3, updated_at: new Date(NOW.getTime() + 120000) });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // held: the owner's regroup, no nightly slot
    const r = await run(db, { domainIds: [db._tables.seo_link_domains[0].id], now: new Date(NOW.getTime() + 180000) }); // a forced run refuses the regroup and parks
    expect(r.errors).toEqual([]);
    expect(new Set(placements(db).map((x) => x.payment_group_id)).size).toBe(1); // unchanged
    const pending = rows(db).filter((x) => x.dimension === 'payment' && !x.satisfied_at);
    expect(pending).toHaveLength(WAVES_LOCATIONS.length - 1);
    expect(pending.every((x) => x.level === 'OWNER_INPUT_REQUIRED' && /owner performs the regroup/.test(x.reason))).toBe(true);
    expect(placements(db).filter((x) => x.authority === 'OWNER_INPUT_REQUIRED' && x.status === 'awaiting_owner')).toHaveLength(WAVES_LOCATIONS.length - 1); // parked for the owner's regroup
    expect(rows(db).find((x) => x.id === charged.id).level).toBe(charged.level); // the charged proof is never re-decided
  });
  test('retiring an instance the path no longer requires invalidates its approval', async () => {
    const { db, p } = scenario({ make: paidPath });
    await run(db);
    const pay = rows(db).find((x) => x.dimension === 'payment');
    const approval = { id: uid(), prospect_id: pay.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_PAYMENT', dimension: 'payment', instance_key: pay.instance_key, invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    pay.approval_id = approval.id;
    Object.assign(db._tables.seo_link_acquisition_paths[0], { payment_required: false, fee_scope: null, estimated_cost_cents: null, revision_payment: 2, updated_at: new Date(NOW.getTime() + 1000) });
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.invalidatedApprovals).toBeGreaterThanOrEqual(1);
    expect(rows(db).find((x) => x.id === pay.id)).toMatchObject({ end_outcome: 'superseded' });
    expect(approval.invalidated_at).toBeTruthy();
    expect(approval.invalidated_reason).toMatch(/no longer required/);
  });
  test('a superseded best path is skipped with a reason and writes nothing', async () => {
    const { db } = scenario({ path: { superseded_by: 'x' } });
    const r = await run(db);
    expect(r.decided).toBe(0);
    expect(r.errors).toEqual([{ domain: 'example.org', skipped: 'best path superseded' }]);
    expect(placements(db)).toHaveLength(0);
  });
  test('a placement still on an older path follows the best path: its unsatisfied instances end as superseded and fresh ones are decided', async () => {
    const { db, d, p } = scenario();
    const old = pathRow(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(old);
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: old.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    db._tables.seo_link_domains[0].agent_state = 'ready_to_acquire'; // not `qualified`: reached only by the stale scan (path_id ≠ best_path_id)
    const r = await run(db);
    expect(r.selected).toBe(1);
    expect(r.ended).toBe(1);
    const mine = rows(db).filter((x) => x.prospect_id === pl.id);
    expect(mine.filter((x) => x.ended_at).map((x) => x.end_outcome)).toEqual(['superseded']);
    expect(mine.filter((x) => !x.ended_at).map((x) => x.instance_key)).toEqual(['-:2']); // next generation — the ended row keeps '-:1' under the full unique
    expect(r.errors).toEqual([]);
    const moved = placements(db).find((x) => x.id === pl.id);
    expect(moved).toMatchObject({ path_id: p.id, target_url: 'https://example.org/add', automation_policy: null }); // settleRetiredPlacements synced URL + cleared the classification
  });
  test('a supersession the mover applied AFTER the bridge ran (at the lease release) is still rotated: the row remembers its path', async () => {
    const { db, d, p } = scenario();
    const old = pathRow(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(old);
    // the placement already sits on the best path (moved by the worker on release); its instance was decided on the old one
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: p.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: old.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: P.decisionInputsHash('execution', { path: p, domain: d, policy: P.normalizePolicyRow(null), score: 75, instanceKey: '-:1' }), path_revision: 1, decided_at: NOW, ended_at: null, satisfied_at: null });
    db._tables.seo_link_domains[0].agent_state = 'watching'; // not bridge-owned ⇒ the location check cannot select it: only the row rule can
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.ended).toBe(1);
    const mine = rows(db).filter((x) => x.prospect_id === pl.id);
    expect(mine.filter((x) => x.ended_at).map((x) => [x.instance_key, x.end_outcome])).toEqual([['-:1', 'superseded']]);
    expect(mine.filter((x) => !x.ended_at).map((x) => [x.instance_key, x.path_id])).toEqual([['-:2', p.id]]);
  });
  test('a changed agreement reopens a SATISFIED accept_terms instance: ended terms_changed, approval invalidated, terms:2 opened and parked', async () => {
    const { db, p } = scenario({ make: outreachPath, path: { legal_attestation: true, legal_terms_hash: HASH } });
    await run(db);
    const terms = rows(db).find((x) => x.instance_kind === 'terms');
    const approval = { id: uid(), prospect_id: terms.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_LEGAL', dimension: 'execution', instance_key: 'terms:1', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    Object.assign(terms, { approval_id: approval.id, satisfied_at: NOW, satisfied_reason: 'human_step_done', accepted_terms_hash: HASH });
    Object.assign(placements(db)[0], { status: 'prospect' });
    // an unchanged agreement is final: nothing is selected
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    Object.assign(db._tables.seo_link_acquisition_paths[0], { legal_terms_hash: 'b'.repeat(64), revision_execution: 2, updated_at: new Date(NOW.getTime() + 1000) });
    const later = new Date(NOW.getTime() + 60000);
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: later });
    expect(r).toMatchObject({ ended: 1, invalidatedApprovals: 1, rowsWritten: 1, parked: 1 });
    expect(rows(db).find((x) => x.id === terms.id)).toMatchObject({ ended_at: later, end_outcome: 'terms_changed', satisfied_at: NOW, accepted_terms_hash: HASH });
    expect(approval).toMatchObject({ invalidated_at: later, invalidated_reason: 'terms_changed' });
    expect(rows(db).filter((x) => x.instance_kind === 'terms' && !x.ended_at).map((x) => [x.instance_key, x.level, x.satisfied_at])).toEqual([['terms:2', 'OWNER_LEGAL', undefined]]);
    expect(placements(db)[0].status).toBe('awaiting_owner');
  });
  test('the investigator re-ranks to a still-LIVE path: the placement follows the best path (no supersession chain) and stops consuming a slot', async () => {
    const { db, d, p } = scenario();
    const other = pathRow(d, { submission_url: 'https://example.org/other' }); // live, not superseded, no longer best
    db._tables.seo_link_acquisition_paths.push(other);
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: other.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: other.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    const r = await run(db);
    expect(r).toMatchObject({ skippedLeased: 0, ended: 1, errors: [] });
    expect(placements(db).find((x) => x.id === pl.id)).toMatchObject({ path_id: p.id, target_url: 'https://example.org/add' });
    expect(rows(db).filter((x) => x.prospect_id === pl.id && !x.ended_at).map((x) => [x.instance_key, x.path_id])).toEqual([['-:2', p.id]]);
    expect(placements(db)).toHaveLength(WAVES_LOCATIONS.length);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('a satisfied ACQUISITION instance proves only the path it ran on: it rotates with the placement; a satisfied payment is carried', async () => {
    const { db, d, p } = scenario({ make: paidPath });
    const old = paidPath(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(old);
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: old.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    const base = { prospect_id: pl.id, path_id: old.id, instance_kind: '-', instance_key: '-:1', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null };
    db._tables.seo_link_placement_authorities.push({ id: uid(), ...base, dimension: 'execution', level: 'OWNER_FREE', satisfied_at: EARLIER, satisfied_reason: 'placed' });
    db._tables.seo_link_placement_authorities.push({ id: uid(), ...base, dimension: 'payment', level: 'OWNER_PAYMENT', satisfied_at: EARLIER, satisfied_reason: 'charged' });
    db._tables.seo_link_domains[0].agent_state = 'watching'; // not bridge-owned ⇒ only the row rule can select it
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    // the placement already moved (a release-time move): the satisfied acquisition row alone must still select the domain
    const already = { ...pl, id: uid(), location_key: WAVES_LOCATIONS[1].id, path_id: p.id };
    db._tables.seo_link_prospects.push(already);
    db._tables.seo_link_placement_authorities.push({ id: uid(), ...base, prospect_id: already.id, dimension: 'execution', level: 'OWNER_FREE', satisfied_at: EARLIER, satisfied_reason: 'placed' });
    Object.assign(pl, { path_id: p.id });
    for (const x of rows(db).filter((y) => y.prospect_id === pl.id)) x.path_id = p.id;
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    Object.assign(pl, { path_id: old.id });
    for (const x of rows(db).filter((y) => y.prospect_id === pl.id)) x.path_id = old.id;
    db._tables.seo_link_prospects.pop();
    db._tables.seo_link_placement_authorities.pop();
    const r = await run(db);
    expect(r.ended).toBe(1);
    const mine = rows(db).filter((x) => x.prospect_id === pl.id);
    expect(mine.filter((x) => x.ended_at).map((x) => [x.dimension, x.end_outcome])).toEqual([['execution', 'superseded']]);
    expect(mine.filter((x) => !x.ended_at).map((x) => [x.dimension, x.instance_key, x.path_id, Boolean(x.satisfied_at)]).sort()).toEqual([['execution', '-:2', p.id, false], ['payment', '-:1', old.id, true]]);
  });
  test('a LEASED prospect is never parked (the claim holds it) and the domain reads acquiring', async () => {
    const { db, d, p } = scenario();
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: p.id, status: 'prospect', link_type: 'directory', claimed_at: NOW, updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    const r = await run(db);
    expect(r.parked).toBe(WAVES_LOCATIONS.length - 1);
    expect(placements(db).find((x) => x.id === pl.id)).toMatchObject({ status: 'prospect', authority: 'OWNER_FREE' });
    expect(domainState(db)).toBe('acquiring');
  });
  test('a re-rank across LANE SHAPES (signup → outreach) never moves the GBP rows into the outreach lane: their open authority ends, the one unscoped conversation is decided', async () => {
    const { db, d } = scenario({ make: outreachPath });
    const signup = pathRow(d, { submission_url: 'https://example.org/add' }); // live, no longer best
    db._tables.seo_link_acquisition_paths.push(signup);
    for (const l of WAVES_LOCATIONS) {
      const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: l.id, domain_id: d.id, path_id: signup.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
      db._tables.seo_link_prospects.push(pl);
      db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: signup.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    }
    const r = await run(db);
    expect(r).toMatchObject({ placementsCreated: 1, rowsWritten: 1, ended: WAVES_LOCATIONS.length, skippedLeased: 0, errors: [] });
    const gbp = placements(db).filter((x) => x.location_key !== '-');
    expect(gbp.every((x) => x.path_id === signup.id && x.link_type === 'directory')).toBe(true); // untouched
    expect(rows(db).filter((x) => gbp.some((g) => g.id === x.prospect_id)).every((x) => x.end_outcome === 'superseded')).toBe(true);
    expect(rows(db).filter((x) => !x.ended_at).map((x) => x.dimension)).toEqual(['communication']);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // converged
  });
  test('an off-shape row still LEASED keeps its authority this run (the worker reports against it); it is retired once released', async () => {
    const { db, d } = scenario({ make: outreachPath });
    const signup = pathRow(d, { submission_url: 'https://example.org/add' });
    db._tables.seo_link_acquisition_paths.push(signup);
    const leased = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: signup.id, status: 'prospect', link_type: 'directory', claimed_at: NOW, updated_at: EARLIER };
    const free = { ...leased, id: uid(), location_key: WAVES_LOCATIONS[1].id, claimed_at: null };
    db._tables.seo_link_prospects.push(leased, free);
    for (const pl of [leased, free]) db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: signup.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'AUTO_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    const r = await run(db);
    expect(r).toMatchObject({ placementsCreated: 1, ended: 1, errors: [] });
    expect(rows(db).find((x) => x.prospect_id === leased.id).ended_at).toBeNull();
    expect(rows(db).find((x) => x.prospect_id === free.id).end_outcome).toBe('superseded');
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // the lease is not a nightly staleness source
    leased.claimed_at = null; // the worker released it
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r2 = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r2.ended).toBe(1);
    expect(rows(db).find((x) => x.prospect_id === leased.id).end_outcome).toBe('superseded');
  });
  test('a zero-total payment proof (no_payment_required) does not cover a paid successor: it rotates; a charged one carries', async () => {
    const { db, d, p } = scenario({ make: paidPath });
    const free = pathRow(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(free);
    const mk = (location, reason) => {
      const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: location, domain_id: d.id, path_id: free.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
      db._tables.seo_link_prospects.push(pl);
      db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: free.id, dimension: 'payment', instance_kind: '-', instance_key: '-:1', level: 'AUTO_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: reason });
      return pl;
    };
    const zero = mk(WAVES_LOCATIONS[0].id, 'no_payment_required');
    const charged = mk(WAVES_LOCATIONS[1].id, 'charged');
    await run(db);
    expect(rows(db).filter((x) => x.prospect_id === zero.id && x.dimension === 'payment').map((x) => [x.instance_key, x.end_outcome || null, x.level]).sort()).toEqual([['-:1', 'superseded', 'AUTO_FREE'], ['-:2', null, 'OWNER_PAYMENT']]);
    expect(rows(db).filter((x) => x.prospect_id === charged.id && x.dimension === 'payment').map((x) => [x.instance_key, x.end_outcome || null])).toEqual([['-:1', null]]);
  });
  test('the aggregate reads the placement status + lease FRESH: a report that promoted a bridged row mid-run wins', async () => {
    const { db } = scenario({ make: outreachPath }); // one placement, so no authorized sibling can outrank it
    let promoted = false;
    db._beforeResolve = (table) => {
      // once the first authority row exists (the snapshot is taken), a worker report lands: prospect → placed
      if (table === 'seo_link_prospects' && !promoted && rows(db).length) { promoted = true; placements(db)[0].status = 'placed'; }
    };
    await run(db);
    expect(placements(db)[0].status).toBe('placed'); // the bridge never overwrote it
    expect(domainState(db)).toBe('acquiring'); // not ready_to_acquire from the stale snapshot
  });
  test('a re-rank moves ONLY the in-shape placements: a legacy unscoped row on the same old signup path stays put (never relabelled outreach)', async () => {
    const { db, d, p } = scenario();
    const other = pathRow(d, { submission_url: 'https://example.org/other' }); // live, no longer best
    db._tables.seo_link_acquisition_paths.push(other);
    const inShape = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: other.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    const legacy = { id: uid(), target_domain: 'example.org', target_page: 'https://www.wavespestcontrol.com/pest-control/', location_key: '-', domain_id: d.id, path_id: other.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(inShape, legacy);
    await run(db);
    expect(placements(db).find((x) => x.id === inShape.id).path_id).toBe(p.id);
    expect(placements(db).find((x) => x.id === legacy.id)).toMatchObject({ path_id: other.id, link_type: 'directory' });
  });
  test('a zero-total proof on the SAME path rotates when the path is revised in place to charge (revision_payment moved); an unchanged path keeps it', async () => {
    const { db, d, p } = scenario({ make: paidPath });
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: p.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: p.id, dimension: 'payment', instance_kind: '-', instance_key: '-:1', level: 'AUTO_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'no_payment_required' });
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: p.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'placed' }); // the full required set, all satisfied
    db._tables.seo_link_domains[0].agent_state = 'watching';
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // same revision: the proof stands
    Object.assign(db._tables.seo_link_acquisition_paths[0], { revision_payment: 2, updated_at: new Date(NOW.getTime() + 1000) });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.ended).toBe(1);
    expect(rows(db).filter((x) => x.prospect_id === pl.id && x.dimension === 'payment').map((x) => [x.instance_key, x.end_outcome || null]).sort()).toEqual([['-:1', 'superseded'], ['-:2', null]]);
  });
  test('a baseline placeholder path (imported existing backlink) is never bridged into new placements', async () => {
    const { db, d } = scenario({ domain: { agent_state: 'acquired' }, path: { baseline: true, last_investigated_at: null } });
    db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: d.best_path_id, status: 'live', link_type: 'directory', updated_at: EARLIER });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    const r = await run(db, { domainIds: [d.id] });
    expect(r.errors).toEqual([{ domain: 'example.org', skipped: 'baseline placeholder (not an executable path)' }]);
    expect(placements(db)).toHaveLength(1);
  });
  test('a location REMOVED from WAVES_LOCATIONS still selects the domain once so its open authority is retired', async () => {
    const { db } = scenario();
    await run(db);
    const gone = placements(db)[0];
    Object.assign(gone, { location_key: 'retired-location' }); // as if WAVES_LOCATIONS swapped this location for another
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['unbridged']); // the replacement location is missing
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ ended: 1, placementsCreated: 1 }); // the retired row's authority ends; the new location is bridged
    expect(rows(db).filter((x) => x.prospect_id === gone.id).map((x) => x.end_outcome)).toEqual(['superseded']);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('a SENT conversation on a re-ranked same-shape path is PINNED: bridged in place, never re-selected nightly, never a retry slot', async () => {
    const { db, d } = scenario({ make: outreachPath });
    const old = outreachPath(d); // live, no longer best
    db._tables.seo_link_acquisition_paths.push(old);
    const sent = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: old.id, status: 'contacted', outreach_status: 'sent', outreach_sent_at: EARLIER, link_type: 'resource', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(sent);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: sent.id, path_id: old.id, dimension: 'communication', instance_kind: '-', instance_key: '-:1', level: 'OWNER_OUTREACH', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'sent' });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // bridged in place
    const r = await run(db, { domainIds: [d.id] });
    expect(r).toMatchObject({ pinned: 1, skippedLeased: 0, placementsCreated: 0, ended: 0, errors: [] });
    expect(placements(db)).toHaveLength(1);
    expect(placements(db)[0]).toMatchObject({ path_id: old.id, status: 'contacted' });
    expect(domainState(db)).toBe('acquiring');
  });
  test('a SENT conversation on the BEST path is still re-decided when the policy moves (pinning forbids path moves only)', async () => {
    const { db, d, p } = scenario({ make: outreachPath, path: { account_required: true } }); // execution instance beside the communication one
    const sent = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: p.id, status: 'contacted', outreach_status: 'sent', outreach_sent_at: EARLIER, link_type: 'resource', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(sent);
    await run(db);
    const exec = rows(db).find((x) => x.prospect_id === sent.id && x.dimension === 'execution');
    expect([exec.level, Boolean(exec.satisfied_at)]).toEqual(['OWNER_ACCOUNT', false]);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    Object.assign(db._tables.seo_link_policy[0], { auto_account_creation: true, updated_at: new Date(NOW.getTime() + 1000) });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: new Date(NOW.getTime() + 1000) })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.redecided).toBeGreaterThanOrEqual(1);
    expect(rows(db).find((x) => x.id === exec.id).level).toBe('AUTO_ACCOUNT');
  });
  test('an in-place re-investigation that ADDS a required instance (a fee) re-selects a fully satisfied placement and opens the new row', async () => {
    const { db, d, p } = scenario();
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: p.id, status: 'live', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, path_id: p.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER, satisfied_reason: 'placed' });
    db._tables.seo_link_domains[0].agent_state = 'watching'; // not bridge-owned: only the instance-set rule can select it
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    Object.assign(db._tables.seo_link_acquisition_paths[0], { acquisition_type: 'paid_listing', payment_required: true, estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } }, revision_payment: 2, updated_at: new Date(NOW.getTime() + 1000) });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ placementsCreated: WAVES_LOCATIONS.length - 1, rowsWritten: 2 * WAVES_LOCATIONS.length - 1 }); // the sibling locations are bridged too; the live one gains exactly its payment row
    expect(rows(db).filter((x) => x.prospect_id === pl.id && !x.ended_at).map((x) => [x.dimension, x.level, Boolean(x.satisfied_at)]).sort()).toEqual([['execution', 'OWNER_FREE', true], ['payment', 'OWNER_PAYMENT', false]]);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('an in-place re-investigation that REMOVES a required instance leaves a satisfied surplus row as history and never re-selects the domain', async () => {
    const { db, d, p } = scenario({ make: paidPath });
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: p.id, status: 'live', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    const base = { prospect_id: pl.id, path_id: p.id, instance_kind: '-', instance_key: '-:1', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: EARLIER };
    db._tables.seo_link_placement_authorities.push({ id: uid(), ...base, dimension: 'execution', level: 'OWNER_FREE', satisfied_reason: 'placed' });
    db._tables.seo_link_placement_authorities.push({ id: uid(), ...base, dimension: 'payment', level: 'OWNER_PAYMENT', satisfied_reason: 'charged' });
    db._tables.seo_link_domains[0].agent_state = 'watching';
    Object.assign(db._tables.seo_link_acquisition_paths[0], { acquisition_type: 'self_service_free', payment_required: false, estimated_cost_cents: null, currency: 'unknown', fee_scope: null, merchant_binding: null }); // the fee went away
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]); // the charged proof is history, not a reason to revisit
    // …but an UNSATISFIED surplus instance still is (the bridge ends it)
    Object.assign(db._tables.seo_link_placement_authorities[1], { satisfied_at: null, satisfied_reason: null });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['stale']);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.ended).toBe(1);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('an UNLOCKED conversation (a draft) on another page bound to the previous path follows the re-rank through the mover', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const old = outreachPath(d); // live, no longer best
    db._tables.seo_link_acquisition_paths.push(old);
    const draft = { id: uid(), target_domain: 'example.org', target_page: 'https://www.wavespestcontrol.com/pest-control/', location_key: '-', domain_id: d.id, path_id: old.id, status: 'prospect', outreach_status: 'drafted', outreach_subject: 'old', outreach_send_token: 'tok', link_type: 'resource', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(draft);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: draft.id, path_id: old.id, dimension: 'communication', instance_kind: '-', instance_key: '-:1', level: 'OWNER_OUTREACH', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    expect((await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['unbridged']); // no in-shape row on the best path yet
    const r = await run(db);
    expect(r).toMatchObject({ placementsCreated: 0, ended: 1, rowsWritten: 1, errors: [] });
    expect(placements(db)).toHaveLength(1);
    expect(placements(db)[0]).toMatchObject({ id: draft.id, path_id: p.id, outreach_status: 'none', outreach_subject: null }); // moved; the draft composed for the old route is cleared
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
  });
  test('the park compare-and-swap includes the outreach state: a send that started after the snapshot is never parked under it', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', outreach_status: 'drafted', link_type: 'resource', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._beforeUpdate = (table) => { if (table === 'seo_link_prospects' && pl.outreach_status === 'drafted') pl.outreach_status = 'sending'; }; // the owner clicked send
    const r = await run(db);
    expect(r.parked).toBe(0);
    expect(placements(db)[0]).toMatchObject({ status: 'prospect', outreach_status: 'sending', authority: 'OWNER_OUTREACH' });
  });
  test('a placement still LEASED on its old path is left alone this run (the registry mover waits for claimed_at IS NULL)', async () => {
    const { db, d, p } = scenario();
    const old = pathRow(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(old);
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: old.id, status: 'prospect', link_type: 'directory', claimed_at: NOW, updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    const row = { id: uid(), prospect_id: pl.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null };
    db._tables.seo_link_placement_authorities.push({ ...row });
    const r = await run(db);
    expect(r.skippedLeased).toBe(1);
    expect(placements(db).find((x) => x.id === pl.id).path_id).toBe(old.id);
    expect(rows(db).filter((x) => x.prospect_id === pl.id)).toEqual([expect.objectContaining({ ...row, ended_at: null })]);
    expect(placements(db)).toHaveLength(WAVES_LOCATIONS.length); // the other locations were still bridged
  });
});

describe('payment grouping', () => {
  test('an account_wide membership shares one payment group across every location and parks at OWNER_MEMBERSHIP', async () => {
    const { db } = scenario({ make: paidPath, path: { acquisition_type: 'membership', fee_scope: 'account_wide', account_required: true } });
    await run(db);
    const ps = placements(db);
    expect(ps).toHaveLength(WAVES_LOCATIONS.length);
    const group = ps[0].payment_group_id;
    expect(group).toBe(ps[0].id);
    expect(ps.every((x) => x.payment_group_id === group && x.status === 'awaiting_owner' && x.authority === 'OWNER_MEMBERSHIP')).toBe(true);
    expect(rows(db).filter((x) => x.dimension === 'payment').every((x) => x.level === 'OWNER_PAYMENT')).toBe(true);
  });
  test('a per_location paid listing is its own group; re-investigation to account_wide joins, back to per_location splits', async () => {
    const { db } = scenario({ make: paidPath });
    await run(db);
    expect(placements(db).every((x) => x.payment_group_id === x.id)).toBe(true);
    Object.assign(db._tables.seo_link_acquisition_paths[0], { fee_scope: 'account_wide', updated_at: new Date(NOW.getTime() + 1000) });
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    const anchor = placements(db)[0].id;
    expect(placements(db).every((x) => x.payment_group_id === anchor)).toBe(true);
    Object.assign(db._tables.seo_link_acquisition_paths[0], { fee_scope: 'per_location', updated_at: new Date(NOW.getTime() + 120000) });
    await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(placements(db).every((x) => x.payment_group_id === x.id)).toBe(true);
  });
});

describe('aggregateState (§3.1)', () => {
  const A = (level, satisfied = false) => ({ level, satisfied_at: satisfied ? NOW : null });
  test.each([
    ['authorized pending wins', [{ status: 'prospect', rows: [A('AUTO_FREE')] }, { status: 'live', rows: [A('OWNER_FREE', true)] }], 'ready_to_acquire'],
    ['satisfied rows count as authorized', [{ status: 'prospect', rows: [A('OWNER_FREE', true), A('OWNER_PAYMENT', true)] }], 'ready_to_acquire'],
    ['an OWNER_* row with a valid approval is authorized', [{ status: 'prospect', rows: [{ level: 'OWNER_FREE', satisfied_at: null, approved: true }] }], 'ready_to_acquire'],
    ['acquired once live with nothing pending', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'rejected', rows: [] }], 'acquired'],
    ['acquiring for the active intermediates', [{ status: 'contacted', rows: [A('OWNER_OUTREACH')] }], 'acquiring'],
    ['qualified while the owner holds it', [{ status: 'awaiting_owner', rows: [A('OWNER_FREE')] }, { status: 'prospect', rows: [A('DENY')] }], 'qualified'],
    ['qualified for a deferred owner decision', [{ status: 'prospect', rows: [A('OWNER_OUTREACH')] }], 'qualified'],
    ['investigating when every placement is INVALID', [{ status: 'prospect', rows: [A('INVALID')] }, { status: 'prospect', rows: [A('INVALID'), A('INVALID')] }], 'investigating'],
    ['rejected only when every placement is DENY', [{ status: 'prospect', rows: [A('DENY')] }], 'rejected'],
    ['a DENY beside an INVALID is not a rejection', [{ status: 'prospect', rows: [A('DENY')] }, { status: 'prospect', rows: [A('INVALID')] }], 'qualified'],
    ['a deferred outreach payment does not hold an authorized send back', [{ status: 'prospect', outreach: true, rows: [A('AUTO_OUTREACH'), { ...A('OWNER_PAYMENT'), dimension: 'payment' }] }], 'ready_to_acquire'],
    ['the publisher step on a send-first outreach path does not hold an authorized send back', [{ status: 'prospect', outreach: true, sendFirst: true, rows: [A('AUTO_OUTREACH'), { ...A('OWNER_HUMAN_STEP'), dimension: 'execution', instance_kind: '-' }] }], 'ready_to_acquire'],
    ['the same step on a submit-first outreach path is pending', [{ status: 'prospect', outreach: true, sendFirst: false, rows: [A('AUTO_OUTREACH'), { ...A('OWNER_HUMAN_STEP'), dimension: 'execution', instance_kind: '-' }] }], 'qualified'],
    ['a leased prospect is acquiring, not pending', [{ status: 'prospect', claimed_at: NOW, rows: [A('AUTO_FREE')] }], 'acquiring'],
    ['live beside a leased sibling is still acquiring', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'prospect', claimed_at: NOW, rows: [A('AUTO_FREE')] }], 'acquiring'],
    ['live beside an owner-held sibling is qualified, not acquired', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'awaiting_owner', rows: [A('OWNER_FREE')] }], 'qualified'],
    ['a carried satisfied payment never masks INVALID', [{ status: 'prospect', rows: [A('OWNER_PAYMENT', true), A('INVALID')] }], 'investigating'],
    ['a carried satisfied communication never masks DENY', [{ status: 'prospect', outreach: true, rows: [A('OWNER_OUTREACH', true), A('DENY')] }], 'rejected'],
    ['a historical lost placement with no rows casts no vote', [{ status: 'prospect', rows: [A('DENY')] }, { status: 'lost', rows: [] }], 'rejected'],
    ['an off-shape contacted row cannot hold the domain at acquiring', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'contacted', offShape: true, rows: [] }], 'acquired'],
    ['an off-shape awaiting_owner row cannot hold the domain at qualified', [{ status: 'prospect', rows: [A('INVALID')] }, { status: 'awaiting_owner', offShape: true, rows: [] }], 'investigating'],
    ['an off-shape live link still reads acquired', [{ status: 'live', offShape: true, rows: [] }, { status: 'rejected', rows: [] }], 'acquired'],
    ['a handoff park is acquiring', [{ status: 'ready_for_payment', rows: [A('OWNER_PAYMENT')] }], 'acquiring'],
    ['an UNLEASED authorized sibling still wins over a leased one', [{ status: 'prospect', claimed_at: NOW, rows: [A('AUTO_FREE')] }, { status: 'prospect', rows: [A('AUTO_FREE')] }], 'ready_to_acquire'],
    ['the same payment row on a non-outreach placement is pending', [{ status: 'prospect', rows: [A('AUTO_FREE'), { ...A('OWNER_PAYMENT'), dimension: 'payment' }] }], 'qualified'],
    ['a CLOSED conversation (§13) is history, not an active intermediate: alone it reads qualified', [{ status: 'contacted', conversation_closed_at: NOW, rows: [A('AUTO_OUTREACH', true)] }], 'qualified'],
    ['a CLOSED conversation beside a live link cannot hold the domain at acquiring', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'contacted', conversation_closed_at: NOW, rows: [A('AUTO_OUTREACH', true)] }], 'acquired'],
    ['no rows ⇒ qualified', [{ status: 'prospect', rows: [] }], 'qualified'],
  ])('%s', (_, placementsIn, expected) => { expect(bridge.aggregateState(placementsIn)).toBe(expected); });
});

describe('approvals (PR 2b writes them; the bridge honours them)', () => {
  test('an OWNER_* row with a valid approval is not re-parked, is released, and reads ready_to_acquire; an invalidated approval gates again', async () => {
    const { db, p } = scenario();
    await run(db);
    const target = rows(db)[0];
    const approval = { id: uid(), prospect_id: target.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_FREE', dimension: 'execution', instance_key: '-:1', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    target.approval_id = approval.id;
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 1000); // something moved ⇒ re-selected
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    const pl = placements(db).find((x) => x.id === target.prospect_id);
    expect(pl).toMatchObject({ status: 'prospect', parked_from_status: null });
    expect(r.released).toBe(1);
    expect(r.parked).toBe(0);
    expect(domainState(db)).toBe('ready_to_acquire');
    approval.invalidated_at = NOW;
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 120000);
    await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(placements(db).find((x) => x.id === target.prospect_id).status).toBe('awaiting_owner');
    expect(domainState(db)).toBe('qualified');
  });
});

describe('a floor waiver on a rejected domain', () => {
  test('the waiver alone re-selects the domain, passes the floors and lets it leave rejected', async () => {
    const { db, d, p } = scenario({ domain: { spam_score: 30 } });
    await run(db);
    expect(domainState(db)).toBe('rejected');
    const policy = P.normalizePolicyRow(null);
    db._tables.seo_link_floor_waivers.push({ id: uid(), domain_id: d.id, path_id: p.id, decision_inputs_hash: P.floorInputsHash({ path: p, domain: d, policy, score: 75 }), overridden_floors: [{ floor: 'spam_score', value: 30, threshold: 10 }], approved_by: 'adam', approved_at: new Date(NOW.getTime() + 1000), invalidated_at: null });
    const sel = await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER });
    expect(sel).toEqual([{ id: d.id, domain: 'example.org', why: 'stale' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r.parked).toBe(WAVES_LOCATIONS.length);
    expect(rows(db).every((x) => x.level === 'OWNER_FREE' && x.floor_waiver_id)).toBe(true);
    expect(domainState(db)).toBe('qualified');
  });
  test('domainIds forces selection whatever the state', async () => {
    const { db, d } = scenario({ domain: { agent_state: 'watching' } });
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    expect(await selection.selectDomains(db, { domainIds: [d.id], limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'forced' }]);
  });
});

describe('a failed domain transaction', () => {
  test('reports nothing it did not commit and rings no bell', async () => {
    const { db } = scenario();
    db._failUpdate = 'seo_link_acquisition_paths'; // the authority_last_decided stamp, after the parks
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r.errors).toEqual([{ domain: 'example.org', error: 'injected failure on seo_link_acquisition_paths' }]);
    expect(r).toMatchObject({ decided: 0, placementsCreated: 0, parked: 0, rowsWritten: 0 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('selection', () => {
  test('a bridged owner-routed domain that stays qualified does not starve the next one (limit 1, two nights)', async () => {
    const { db } = scenario();
    const d2 = domainRow({ domain: 'two.example', updated_at: NOW });
    const p2 = pathRow(d2, { submission_url: 'https://two.example/add' });
    d2.best_path_id = p2.id;
    db._tables.seo_link_domains.push(d2);
    db._tables.seo_link_acquisition_paths.push(p2);
    const r1 = await run(db, { limit: 1 });
    expect(r1).toMatchObject({ selected: 1, placementsCreated: WAVES_LOCATIONS.length });
    const r2 = await run(db, { limit: 1, now: new Date(NOW.getTime() + 60000) });
    expect(r2).toMatchObject({ selected: 1, placementsCreated: WAVES_LOCATIONS.length }); // the SECOND domain
    expect(new Set(placements(db).map((x) => x.target_domain))).toEqual(new Set(['example.org', 'two.example']));
    const r3 = await run(db, { limit: 1, now: new Date(NOW.getTime() + 120000) });
    expect(r3.selected).toBe(0); // both current: nothing to do
  });
  test('a GBP location added after the bridge ran makes the domain unbridged again in EVERY bridge-owned state — only the missing placement is created', async () => {
    const { db, d } = scenario({ policy: { auto_free_acquisition: true } });
    await run(db);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(placements(db)).toHaveLength(WAVES_LOCATIONS.length);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([]);
    // simulate the config change: the last location's placement never existed
    const gone = placements(db).pop();
    db._tables.seo_link_placement_authorities = db._tables.seo_link_placement_authorities.filter((x) => x.prospect_id !== gone.id);
    expect(await selection.selectDomains(db, { domainIds: null, limit: 10, policyUpdatedAt: EARLIER })).toEqual([{ id: d.id, domain: 'example.org', why: 'unbridged' }]);
    const r = await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(r).toMatchObject({ placementsCreated: 1, rowsWritten: 1, redecided: 0 });
    expect(placements(db).map((x) => x.location_key).sort()).toEqual(WAVES_LOCATIONS.map((l) => l.id).sort());
  });
  test('limit caps and dedupes across the sources; domainIds narrows', async () => {
    const { db, d } = scenario();
    const d2 = domainRow({ domain: 'two.example', updated_at: NOW });
    const p2 = pathRow(d2);
    d2.best_path_id = p2.id;
    db._tables.seo_link_domains.push(d2);
    db._tables.seo_link_acquisition_paths.push(p2);
    expect((await selection.selectDomains(db, { domainIds: null, limit: 1, policyUpdatedAt: EARLIER })).map((x) => x.id)).toEqual([d.id]);
    expect((await selection.selectDomains(db, { domainIds: [d2.id], limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.why)).toEqual(['forced']);
    const r = await run(db, { limit: 1 });
    expect(r.selected).toBe(1);
  });
});


test('an active backlink scan blocks auto-send and reconciliation until the lease is available', async () => {
  const { db } = scenario();
  const reconcile = require('../services/seo/link-prospect-verifier').reconcileOutreach;
  reconcile.mockClear();
  const send = jest.fn();
  const result = await run(db, { autoSend: true, send, exclusive: async (key, fn) => key === 'backlink-scan' ? { skipped: true, reason: 'lease_held' } : fn() });
  expect(result.autoSend).toEqual({ attempted: 0, sent: 0, skipped: [{ code: 'backlink_scan_busy' }] });
  expect(reconcile).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
test('every automatic dispatch retries evidence reconciliation under the scan lease and fails closed', async () => {
  const { db } = scenario();
  const reconcile = require('../services/seo/link-prospect-verifier').reconcileOutreach;
  let scanHeld = false;
  reconcile.mockImplementationOnce(async () => { expect(scanHeld).toBe(true); throw new Error('synthetic reconciliation failure'); });
  const send = jest.fn();
  const result = await run(db, { autoSend: true, send, exclusive: async (key, fn) => { scanHeld = key === 'backlink-scan'; try { return await fn(); } finally { scanHeld = false; } } });
  expect(result.errors).toContainEqual({ autoSend: 'synthetic reconciliation failure' });
  expect(send).not.toHaveBeenCalled();
});
