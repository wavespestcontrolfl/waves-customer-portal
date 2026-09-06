/**
 * MUTATES only inside a rolled-back transaction: synthetic backlink acceptance checks.
 * Requires the backlink schema on a verified dev/preview Postgres database, no external
 * provider keys. Set WAVES_DATABASE_ENVIRONMENT=test and BACKLINK_TEST_DATABASE_URL.
 * Run from the repository root: node scripts/qa/backlink-execution.cjs
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = { ...process.env, DATABASE_URL: process.env.BACKLINK_TEST_DATABASE_URL };
if (env.WAVES_DATABASE_ENVIRONMENT !== 'test' || !new URL(env.DATABASE_URL).pathname.startsWith('/waves_qa_')) throw Error('Synthetic preview database required');
const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL, pool: { min: 0, max: 3 } });
const root = process.cwd();
const stub = (file, value) => { const id = require.resolve(`${root}/server/${file}`); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
const gates = new Set(['linkAuthority', 'signupRunner', 'outreachDrafter', 'linkProspectOutreach']);
stub('config/feature-gates', { isEnabled: (k) => gates.has(k) });
stub('services/logger', { info() {}, warn() {}, error() {} });
stub('services/seo/signup-evidence', { getEvidenceUrl: async (key, options) => { assert.equal(options.expiresIn, 900); return key ? 'https://synthetic.example/evidence.png' : null; } });
let active;
const proxy = (...a) => active(...a);
proxy.transaction = (...a) => active.transaction(...a);
proxy.raw = (...a) => active.raw(...a);
stub('models/db', proxy);
stub('services/email/gmail-client', { isConnected: async () => true, sendMessage: async () => { throw Error('Synthetic check must never send'); }, getThread: async () => { throw Error('Lease refusal must precede Gmail access'); } });
const P = require(`${root}/server/services/seo/link-authority-policy`);
const B = require(`${root}/server/services/seo/link-authority-bridge`);
const W = require(`${root}/server/services/seo/link-prospect-worker`);
const E = require(`${root}/server/services/seo/link-execution-authority`);
const migration = require(`${root}/server/models/migrations/20260905000090_link_execution_leases`);
(async () => {
  const trx = await db.transaction(); active = trx;
  try {
    await require(`${root}/server/models/migrations/20260830000010_backlink_worker_auth_step1b`).up(trx);
    await migration.up(trx); await migration.up(trx); await migration.down(trx); await migration.down(trx); await migration.up(trx);
    console.log('PASS migration up/up/down/down/up in rollback');
    const id = randomUUID(), pathId = randomUUID();
    const domain = `synthetic-${id}.example`;
    await trx('seo_link_domains').insert({ id, domain, source: 'owner_seed', agent_state: 'qualified', score: 85, spam_score: 1 });
    await trx('seo_link_acquisition_paths').insert({ id: pathId, domain_id: id, acquisition_type: 'self_service_free', submission_url: `https://${domain}/add`, path_key: `test:${id}`, account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: true, link_type: 'directory', confidence: 0.9, last_investigated_at: new Date(), terms_accepted_by_send: false, execution_after_send: true, currency: 'unknown' });
    await trx('seo_link_domains').where({ id }).update({ best_path_id: pathId });
    await P.updatePolicy(trx, { auto_free_acquisition: true, auto_submission_daily_cap: 1 }, { actor: 'synthetic-preview' });
    const bridge = await B.runAuthorityBridge(trx, { domainIds: [id], autoSend: false, exclusive: (_k, fn) => fn(), notify: async () => {} });
    assert.equal(bridge.errors?.length || 0, 0);
    assert.deepEqual(await W.claim({ provider: 'hermes', domains: [domain] }), []);
    const leases = await W.claim({ provider: 'deterministic_runner', domains: [domain], n: 5 });
    assert.equal(leases.length, 1, JSON.stringify(bridge));
    assert.equal((await W.claim({ provider: 'deterministic_runner', domains: [domain] })).length, 0);
    const p = leases[0];
    assert.equal((await W.report({ prospect_id: p.id, provider: 'deterministic_runner', lease_token: p.lease_token, outcome: 'placed', pending: true })).code, 'submit_not_started');
    gates.delete('linkAuthority');
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token, citation: { website: 'https://wavespestcontrol.com', location: p.location_key } }), false);
    gates.add('linkAuthority');
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token, citation: { website: 'https://wavespestcontrol.com', location: p.location_key } }), true);
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token, citation: { website: 'https://wavespestcontrol.com', location: p.location_key } }), false);
    assert.equal((await W.report({ prospect_id: p.id, provider: 'hermes', lease_token: p.lease_token, outcome: 'placed', pending: true })).code, 'stale_lease');
    assert.equal((await W.report({ prospect_id: p.id, provider: 'deterministic_runner', lease_token: p.lease_token, outcome: 'placed', pending: true })).ok, true);
    const stored = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(stored.status, 'placed');
    assert.equal((await trx('seo_link_placement_authorities').where({ prospect_id: p.id, dimension: 'execution' }).first()).satisfied_reason, 'placed');
    console.log('PASS bridge → one capped lease → kill/replay/provider refusals → pending placement and authority settlement');
    await trx('seo_link_acquisition_paths').where({ id: pathId }).update({ acquisition_type: 'content_submission', link_type: 'editorial', execution_after_send: false });
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'live', live_url: `https://www.${domain}/confirmed`, link_type: 'editorial', attempts: 2 });
    const [draftLease] = await W.claim({ type: 'outreach', mode: 'draft', provider: 'hermes', domains: [domain] });
    assert.ok(draftLease);
    assert.equal((await W.report({ prospect_id: p.id, provider: 'hermes', lease_token: draftLease.lease_token, outcome: 'skipped' })).ok, true);
    const afterDraft = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(afterDraft.status, 'live'); assert.equal(afterDraft.attempts, 2); assert.equal(afterDraft.outreach_draft_attempts, W.MAX_ATTEMPTS);
    assert.deepEqual(await W.claim({ type: 'outreach', mode: 'draft', provider: 'hermes', domains: [domain] }), []);
    console.log('PASS skipped late pitch preserves live lifecycle and acquisition attempts, then stops reclaiming');
    assert.equal((await require(`${root}/server/services/seo/link-prospect-outreach`).saveDraft({ prospectId: p.id, to: 'editor@synthetic.example', subject: 'Synthetic late pitch', body: 'Synthetic draft saved for review.' })).ok, true);
    const savedPitch = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(savedPitch.status, 'live'); assert.equal(savedPitch.outreach_status, 'drafted'); assert.equal(savedPitch.outreach_draft_attempts, 0);
    console.log('PASS exhausted late pitch saves a new draft without sending or changing live placement');
    // Recipient lookup is outside this synthetic backlink schema; no customer records are queried.
    require(`${root}/server/services/seo/link-outreach-mandate`).reviewByEmail = async () => new Map();
    const router = require(`${root}/server/routes/admin-backlink-agent-v2`);
    const pending = router.stack.find(l => l.route?.path === '/prospects/outreach/pending' && l.route.methods.get).route.stack.at(-1).handle;
    const pendingIds = async () => {
      const response = await new Promise((resolve, reject) => pending({}, { json: resolve }, reject));
      return response.items.map(row => row.id);
    };
    for (const status of ['placed', 'live', 'indexed']) {
      await trx('seo_link_prospects').where({ id: p.id }).update({ status });
      assert.ok((await pendingIds()).includes(p.id), `${status} late draft must remain available for owner approval`);
    }
    const alternatePathId = randomUUID();
    const originalPath = await trx('seo_link_acquisition_paths').where({ id: pathId }).first();
    await trx('seo_link_acquisition_paths').insert({ ...originalPath, id: alternatePathId, path_key: `test:${alternatePathId}` });
    for (const best_path_id of [null, alternatePathId]) {
      await trx('seo_link_domains').where({ id }).update({ best_path_id });
      for (const status of ['placed', 'live', 'indexed']) {
        await trx('seo_link_prospects').where({ id: p.id }).update({ status });
        assert.equal((await pendingIds()).includes(p.id), false, `${status} late approval requires the current best path`);
      }
    }
    await trx('seo_link_domains').where({ id }).update({ best_path_id: pathId });
    assert.ok((await pendingIds()).includes(p.id));
    console.log('PASS late approvals hide changed/cleared best paths and return when the original path is restored');
    for (const agent_state of ['rejected', 'watching', 'not_reproducible']) {
      await trx('seo_link_domains').where({ id }).update({ agent_state });
      for (const status of ['placed', 'live', 'indexed']) {
        await trx('seo_link_prospects').where({ id: p.id }).update({ status });
        assert.equal((await pendingIds()).includes(p.id), false, `${agent_state} domain must not offer ${status} late approval`);
      }
      // Ambiguous sends remain recoverable even when their domain cannot acquire.
      await trx('seo_link_prospects').where({ id: p.id }).update({ outreach_status: 'send_error' });
      const response = await new Promise((resolve, reject) => pending({}, { json: resolve }, reject));
      assert.ok(response.needsReconcile.some(row => row.id === p.id));
      await trx('seo_link_prospects').where({ id: p.id }).update({ outreach_status: 'drafted' });
    }
    await trx('seo_link_domains').where({ id }).update({ agent_state: 'acquiring' });
    assert.ok((await pendingIds()).includes(p.id));
    await trx('seo_link_acquisition_paths').where({ id: pathId }).update({ execution_after_send: true });
    assert.equal((await pendingIds()).includes(p.id), false);
    await trx('seo_link_acquisition_paths').where({ id: pathId }).update({ execution_after_send: false });
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'rejected' });
    assert.equal((await pendingIds()).includes(p.id), false);
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'live' });
    console.log('PASS late draft approval queue includes placed/live/indexed submit-first rows and excludes send-first/terminal rows');
    const executionStep = await trx('seo_link_placement_authorities').where({ prospect_id: p.id, dimension: 'execution', instance_kind: '-' }).first();
    const lateQueue = require(`${root}/server/services/seo/link-owner-queue`);
    for (const status of ['placed', 'live', 'indexed']) {
      const check = await trx.transaction(); active = check;
      try {
        await check('seo_link_prospects').where({ id: p.id }).update({ status });
        const bridged = await B.runAuthorityBridge(check, { domainIds: [id], autoSend: false, exclusive: (_key, fn) => fn(), notify: async () => {} });
        assert.equal(bridged.errors.length, 0);
        assert.ok((await pendingIds()).includes(p.id));
        assert.ok((await lateQueue.listOwnerQueue(proxy)).cards.some(card => card.placement.id === p.id));
        await check('seo_link_placement_authorities').where({ id: executionStep.id }).update({ satisfied_at: null, satisfied_reason: null });
        assert.equal((await pendingIds()).includes(p.id), false);
        assert.equal((await lateQueue.listOwnerQueue(proxy)).cards.some(card => card.placement.id === p.id), false);
        await check('seo_link_placement_authorities').where({ id: executionStep.id }).update({ satisfied_at: new Date(), satisfied_reason: 'placed' });
        assert.ok((await pendingIds()).includes(p.id));
        assert.ok((await lateQueue.listOwnerQueue(proxy)).cards.some(card => card.placement.id === p.id));
        await check('seo_link_placement_authorities').where({ id: executionStep.id }).update({ ended_at: new Date(), end_outcome: 'superseded' });
        assert.equal((await pendingIds()).includes(p.id), false);
        assert.equal((await lateQueue.listOwnerQueue(proxy)).cards.some(card => card.placement.id === p.id), false);
      } finally { await check.rollback(); active = trx; }
    }
    console.log('PASS both late-send approval views require current completed execution across placed/live/indexed');
    const rejectedLease = new Date(), rejectedAttempt = randomUUID();
    await trx('seo_link_prospects').where({ id: p.id }).update({ claimed_at: rejectedLease, lease_mode: 'acquire', leased_provider: 'deterministic_runner' });
    await trx('seo_link_attempts').insert({ id: rejectedAttempt, prospect_id: p.id, path_id: pathId, provider: 'deterministic_runner', action: 'submit', outcome: 'submitting', lease_token: rejectedLease.toISOString(), detail: { authority_id: 'synthetic-authority' } });
    await trx('seo_link_prospects').where({ id: p.id }).update({ outreach_status: 'sent', outreach_sent_at: new Date(Date.now() - 11 * 86400000), outreach_to_email: 'editor@synthetic.example', outreach_subject: 'Synthetic pitch', outreach_thread_ref: 'synthetic-thread', follow_up_status: 'drafted', follow_up_subject: 'Re: Synthetic pitch', follow_up_body: 'Synthetic follow-up', follow_up_due_at: new Date(Date.now() - 86400000) });
    const blockedSend = await require(`${root}/server/services/seo/link-prospect-outreach`).sendOutreach({ prospectId: p.id, followUp: true });
    assert.equal(blockedSend.code, 'acquisition_in_progress');
    assert.equal((await trx('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'submitting');
    assert.equal((await trx('seo_link_prospects').where({ id: p.id }).first()).claimed_at.toISOString(), rejectedLease.toISOString());
    console.log('PASS follow-up send refuses an active acquisition without clearing its lease or submitting slot');
    const runner = require(`${root}/server/services/seo/signup-runner`)._internals;
    await runner.leaseGuardedReclassify({ ...afterDraft, lease_token: rejectedLease.toISOString() }, { automation_policy: 'skip' }, { evidence_url: 'synthetic/evidence.png', detail: JSON.stringify({ error_code: 'submit_rejected', error_message: 'Synthetic rejection' }) });
    const heldAttempt = await trx('seo_link_attempts').where({ id: rejectedAttempt }).first();
    assert.equal(heldAttempt.outcome, 'submit_ambiguous'); assert.equal(heldAttempt.evidence_url, 'synthetic/evidence.png');
    assert.deepEqual(heldAttempt.detail, { authority_id: 'synthetic-authority', error_code: 'submit_rejected', error_message: 'Synthetic rejection' });
    const released = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(released.claimed_at, null); assert.equal(released.lease_mode, null); assert.equal(released.leased_provider, null);
    console.log('PASS held submit preserves screenshot/reason/authority on the original attempt and releases lease stamps');
    const authority = await trx('seo_link_placement_authorities').where({ prospect_id: p.id, dimension: 'execution', instance_kind: '-' }).first();
    await trx('seo_link_placement_authorities').where({ id: authority.id }).update({ satisfied_at: null, satisfied_reason: null });
    await trx('seo_link_attempts').where({ id: rejectedAttempt }).update({ detail: { ...heldAttempt.detail, authority_id: authority.id } });
    await require(`${root}/server/models/migrations/20260419000005_audit_log`).up(trx);
    const edit = router.stack.find(l => l.route?.path === '/prospects/:id' && l.route.methods.patch).route.stack.at(-1).handle;
    const queue = await require(`${root}/server/services/seo/link-owner-queue`).listOwnerQueue(proxy);
    assert.equal(queue.cards.find((card) => card.placement.id === p.id).submission_ambiguity.evidence_url, 'https://synthetic.example/evidence.png');
    const Q = require(`${root}/server/services/seo/link-owner-queue`);
    for (const agent_state of ['rejected', 'watching', 'not_reproducible']) {
      await trx('seo_link_domains').where({ id }).update({ agent_state });
      const recoveryCards = (await Q.listOwnerQueue(proxy)).cards;
      assert.equal(recoveryCards.length, 1);
      assert.equal(recoveryCards[0].submission_ambiguity.id, rejectedAttempt);
      assert.deepEqual(recoveryCards[0].rows, []);
      assert.equal(recoveryCards[0].backlink_match, null);
      assert.equal(recoveryCards[0].outreach_draft_exhausted, false);
      assert.equal(recoveryCards[0].decidable, false);
    }
    await trx('seo_link_domains').where({ id }).update({ agent_state: 'acquiring' });
    for (const status of ['rejected', 'watching', 'lost']) {
      await trx('seo_link_prospects').where({ id: p.id }).update({ status });
      const [recovery] = (await Q.listOwnerQueue(proxy)).cards;
      assert.equal(recovery.submission_ambiguity.id, rejectedAttempt);
      assert.deepEqual(recovery.rows, []);
      assert.equal(recovery.decidable, false);
      assert.equal(recovery.backlink_match, null);
      assert.equal(recovery.outreach_draft_exhausted, false);
    }
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'live' });
    await trx('seo_link_domains').where({ id }).update({ agent_state: 'rejected' });
    console.log('PASS held submission remains visible outside acquisition states without approval/assignment actions');
    const confirm = (overrides = {}) => new Promise((resolve, reject) => edit({ params: { id: p.id }, body: { submission_attempt_id: rejectedAttempt, submission_verdict: 'placed', live_url: `https://www.${domain}/confirmed`, ...overrides } }, { json: resolve, status(code) { return { json: body => reject(Error(`${code}: ${JSON.stringify(body)}`)) }; } }, reject));
    await assert.rejects(confirm({ submission_attempt_id: randomUUID() }), /409/);
    await assert.rejects(confirm({ live_url: 'javascript:alert(1)' }), /400/);
    for (const live_url of ['https://unrelated.example/listing', `https://${domain}.unrelated.example/listing`]) {
      await assert.rejects(confirm({ live_url }), /409/);
      assert.equal((await trx('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'submit_ambiguous');
      assert.equal((await trx('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_at, null);
      assert.equal((await trx('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
    }
    for (const status of ['live', 'indexed']) {
      const check = await trx.transaction(); active = check;
      try {
        await check('seo_link_prospects').where({ id: p.id }).update({ status, indexing_status: 'indexed', last_index_check: new Date(), last_live_check: new Date() });
        const beforePlacement = await check('seo_link_prospects').where({ id: p.id }).first();
        const beforeAttempt = await check('seo_link_attempts').where({ id: rejectedAttempt }).first();
        const editUrl = live_url => new Promise((resolve, reject) => edit({ params: { id: p.id }, body: { live_url } }, { json: resolve, status(code) { return { json: body => reject(Error(`${code}: ${JSON.stringify(body)}`)) }; } }, reject));
        await assert.rejects(editUrl(`https://${domain}/different-page`), /409.*held submission/);
        await assert.rejects(editUrl(null), /409.*held submission/);
        await assert.rejects(confirm({ live_url: `https://${domain}/different-page` }), /409.*verified publisher URL/);
        assert.deepEqual(await check('seo_link_prospects').where({ id: p.id }).first(), beforePlacement);
        assert.deepEqual(await check('seo_link_attempts').where({ id: rejectedAttempt }).first(), beforeAttempt);
        assert.equal((await check('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
      } finally { await check.rollback(); active = trx; }
    }
    console.log('PASS confirmation cannot replace a live/indexed publisher URL or reuse its verification evidence');
    await trx('seo_link_prospects').where({ id: p.id }).update({ location_key: '-', target_page: '/sarasota-pest-control/' });
    await new Promise((resolve, reject) => edit({ params: { id: p.id }, body: { target_page: '/venice-pest-control/' } }, { json: resolve }, reject));
    const beforeRefusal = await trx('seo_link_prospects').where({ id: p.id }).first();
    await assert.rejects(confirm(), /409.*identity/);
    assert.deepEqual(await trx('seo_link_prospects').where({ id: p.id }).first(), beforeRefusal);
    const unresolved = await trx('seo_link_attempts').where({ id: rejectedAttempt }).first();
    assert.equal(unresolved.outcome, 'submit_ambiguous');
    assert.equal((await trx('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_at, null);
    assert.equal((await trx('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
    // A snapshot recorded at the mutation boundary remains authoritative after the same board edit.
    await trx('seo_link_attempts').where({ id: rejectedAttempt }).update({ detail: { ...unresolved.detail, execution_revision: authority.path_revision, citation: { website: 'https://wavespestcontrol.com', location: p.location_key } } });
    console.log('PASS legacy hold refuses mutable board identity without writes; boundary snapshot survives the edit');
    for (const changedInputs of [{ submission_url: `https://${domain}/new-form` }, { account_required: true }]) {
      for (const runBridge of [false, true]) {
        const check = await trx.transaction(); active = check;
        try {
          await check('seo_link_acquisition_paths').where({ id: pathId }).update({ ...changedInputs, revision: 2, revision_execution: 2 });
          if (runBridge) {
            const result = await B.runAuthorityBridge(check, { domainIds: [id], autoSend: false, exclusive: (_key, fn) => fn(), notify: async () => {} });
            assert.equal(result.errors.length, 0);
            assert.equal((await check('seo_link_placement_authorities').where({ id: authority.id }).first()).path_revision, 2);
          }
          const beforeAttempt = await check('seo_link_attempts').where({ id: rejectedAttempt }).first();
          const beforePlacement = await check('seo_link_prospects').where({ id: p.id }).first();
          const beforeAuthority = await check('seo_link_placement_authorities').where({ id: authority.id }).first();
          await assert.rejects(confirm(), /409.*execution revision/);
          assert.deepEqual(await check('seo_link_attempts').where({ id: rejectedAttempt }).first(), beforeAttempt);
          assert.deepEqual(await check('seo_link_prospects').where({ id: p.id }).first(), beforePlacement);
          assert.deepEqual(await check('seo_link_placement_authorities').where({ id: authority.id }).first(), beforeAuthority);
          assert.equal((await check('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
        } finally { await check.rollback(); active = trx; }
      }
    }
    console.log('PASS URL/account execution revisions refuse confirmation before and after real bridge redecision');
    for (const sibling of [
      { target_domain: domain, target_page: '/venice-pest-control/' },
      { target_domain: `www.${domain}`, target_page: 'https://www.wavespestcontrol.com/venice-pest-control/' },
    ]) {
      const check = await trx.transaction(); active = check;
      try {
        await check('seo_link_prospects').insert({ ...sibling, location_key: p.location_key, status: 'live', link_type: 'directory' });
        const beforePlacement = await check('seo_link_prospects').where({ id: p.id }).first();
        await assert.rejects(confirm(), /409.*Another placement/);
        assert.deepEqual(await check('seo_link_prospects').where({ id: p.id }).first(), beforePlacement);
        assert.equal((await check('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'submit_ambiguous');
        assert.equal((await check('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_at, null);
        assert.equal((await check('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
      } finally { await check.rollback(); active = trx; }
    }
    // A legacy status edit may move the page and confirm in one PATCH: probe the resulting identity too.
    const moving = await trx.transaction(); active = moving;
    try {
      await moving('seo_link_prospects').insert({ target_domain: domain, target_page: 'https://wavespestcontrol.com/pest-control/', location_key: p.location_key, status: 'live', link_type: 'directory' });
      const beforePlacement = await moving('seo_link_prospects').where({ id: p.id }).first();
      await assert.rejects(confirm({ submission_verdict: undefined, status: 'placed', target_page: 'https://wavespestcontrol.com/pest-control/' }), /409.*Another placement/);
      assert.deepEqual(await moving('seo_link_prospects').where({ id: p.id }).first(), beforePlacement);
      assert.equal((await moving('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'submit_ambiguous');
      assert.equal((await moving('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 0);
      // A move away from a collision must update page + restored location atomically, without an intermediate unique violation.
      await moving('seo_link_prospects').insert({ target_domain: domain, target_page: beforePlacement.target_page, location_key: p.location_key, status: 'live', link_type: 'directory' });
      const moved = await confirm({ submission_verdict: undefined, status: 'placed', target_page: 'https://wavespestcontrol.com/mosquito-control/' });
      assert.equal(moved.prospect.target_page, 'https://wavespestcontrol.com/mosquito-control/');
      assert.equal(moved.prospect.location_key, p.location_key);
    } finally { await moving.rollback(); active = trx; }
    console.log('PASS exact/canonical restored-location collisions and simultaneous page move return 409 without writes');
    for (const status of ['prospect', 'live', 'indexed']) {
      const check = await trx.transaction(); active = check;
      try {
        const successorId = randomUUID();
        const predecessor = await check('seo_link_acquisition_paths').where({ id: pathId }).first();
        await check('seo_link_acquisition_paths').insert({ ...predecessor, id: successorId, path_key: `successor:${successorId}`, submission_url: `https://${domain}/successor` });
        await check('seo_link_acquisition_paths').where({ id: pathId }).update({ superseded_by: successorId });
        await check('seo_link_domains').where({ id }).update({ best_path_id: successorId });
        await check('seo_link_prospects').where({ id: p.id }).update({ status, outreach_status: 'drafted', outreach_sent_at: null, outreach_subject: 'Retired path draft', outreach_body: 'Retired path body' });
        const beforeAttempt = await check('seo_link_attempts').where({ id: rejectedAttempt }).first();
        const response = await confirm({ live_url: `https://www.${domain}/confirmed` });
        const placed = await check('seo_link_prospects').where({ id: p.id }).first();
        assert.deepEqual(response.prospect, placed);
        assert.equal(placed.path_id, successorId);
        assert.equal(placed.target_url, `https://${domain}/successor`);
        assert.equal(placed.status, status === 'prospect' ? 'placed' : status);
        assert.equal(placed.live_url, `https://www.${domain}/confirmed`);
        assert.equal(placed.outreach_status, 'none');
        assert.equal(placed.outreach_body, null);
        const afterAttempt = await check('seo_link_attempts').where({ id: rejectedAttempt }).first();
        assert.equal(afterAttempt.outcome, 'placed');
        assert.equal(afterAttempt.path_id, pathId);
        assert.deepEqual(afterAttempt.detail.citation, beforeAttempt.detail.citation);
        assert.equal((await check('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_reason, 'placed');
        assert.equal((await check('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 1);
        await assert.rejects(confirm(), /409/);
      } finally { await check.rollback(); active = trx; }
    }
    console.log('PASS positive owner verdict settles retired paths, clears stale drafts and preserves submitted evidence and lifecycle');
    assert.equal((await confirm({ live_url: `https://www.${domain}/confirmed` })).prospect.status, 'live');
    assert.equal((await trx('seo_link_domains').where({ id }).first()).agent_state, 'rejected');
    assert.equal((await Q.listOwnerQueue(proxy)).cards.length, 0);
    await trx('seo_link_domains').where({ id }).update({ agent_state: 'acquiring' });

    assert.equal((await trx('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'placed');
    const recoveredCitation = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(recoveredCitation.quality_signals.cited_homepage, true);
    assert.equal(recoveredCitation.quality_signals.submitted_at, rejectedLease.toISOString());
    const oldLinkId = randomUUID();
    await trx('seo_backlinks').insert({ id: oldLinkId, source_domain: domain, source_url: `https://${domain}/old-listing`, target_url: 'https://wavespestcontrol.com', status: 'active', discovery_source: 'dataforseo', first_seen: require(`${root}/server/utils/datetime-et`).etDateString(new Date(rejectedLease.getTime() - 10 * 86400000)) });
    const V = require(`${root}/server/services/seo/link-prospect-verifier`);
    assert.equal(await V.reconcileByDomain(recoveredCitation), null);
    await trx('seo_backlinks').where({ id: oldLinkId }).update({ first_seen: require(`${root}/server/utils/datetime-et`).etDateString(new Date(rejectedLease.getTime() + 2 * 86400000)) });
    assert.equal((await V.reconcileByDomain(recoveredCitation)).id, oldLinkId);
    console.log('PASS recovered submission rejects older homepage evidence and accepts later evidence');

    assert.equal(recoveredCitation.quality_signals.location, p.location_key);
    assert.equal(require(`${root}/server/services/seo/link-prospect-verifier`)._test.expectedTargetUrl(recoveredCitation), 'https://wavespestcontrol.com');
    assert.equal((await trx('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_reason, 'placed');
    await assert.rejects(confirm(), /409/);
    assert.equal((await trx('audit_log').where({ resource_id: p.id, action: 'backlink.submission.confirm' })).length, 1);
    console.log('PASS existing owner board edit atomically resolves the hold and execution authority with one audit record');
    for (const releaseMode of ['runner', 'releaseClaims', 'sweep']) {
      const did = randomUUID(), oldPath = randomUUID(), newPath = randomUUID(), pid = randomUUID(), attemptId = randomUUID();
      const oldLease = new Date(Date.now() - 9 * 3600000), host = `synthetic-${did}.example`;
      await trx('seo_link_domains').insert({ id: did, domain: host, source: 'owner_seed', agent_state: 'acquiring' });
      for (const [path, key] of [[newPath, 'new'], [oldPath, 'old']]) await trx('seo_link_acquisition_paths').insert({ id: path, domain_id: did, path_key: key, acquisition_type: 'self_service_free', link_type: 'directory', account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: true, submission_url: `https://${host}/${key}`, confidence: 0.9, revision: 1, ...(key === 'old' ? { superseded_by: newPath } : {}) });
      await trx('seo_link_prospects').insert({ id: pid, domain_id: did, path_id: oldPath, target_domain: host, target_page: '/', status: 'prospect', link_type: 'directory', claimed_at: oldLease, leased_provider: 'deterministic_runner', lease_mode: 'acquire', leased_path_revision: 1 });
      await trx('seo_link_attempts').insert({ id: attemptId, prospect_id: pid, path_id: oldPath, provider: 'deterministic_runner', action: 'submit', outcome: 'submitting', lease_token: oldLease.toISOString() });
      const lease = { id: pid, lease_token: oldLease.toISOString() };
      if (releaseMode === 'runner') await runner.leaseGuardedReclassify(lease, { automation_policy: 'skip' });
      else if (releaseMode === 'releaseClaims') await W.releaseClaims([lease]);
      else await W.sweepExpiredClaims();
      assert.equal((await trx('seo_link_prospects').where({ id: pid }).first()).path_id, oldPath);
      assert.equal((await trx('seo_link_attempts').where({ id: attemptId }).first()).outcome, 'submit_ambiguous');
    }
    console.log('PASS runner/releaseClaims/expired sweep keep ambiguous submissions pinned to their original path');
    // The same reviewed attempt cannot be used to release a later retry's hold.
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'prospect', automation_policy: 'skip', outreach_status: 'none', outreach_sent_at: null, follow_up_status: 'none', follow_up_due_at: null });
    const [heldNow] = await trx('seo_link_attempts').insert({ prospect_id: p.id, path_id: pathId, provider: 'deterministic_runner', action: 'submit', outcome: 'submit_ambiguous', detail: { authority_id: authority.id, error_code: 'submit_rejected' } }).returning('*');
    const negative = body => new Promise((resolve, reject) => edit({ params: { id: p.id }, body }, { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } }, reject));
    const verdict = { submission_verdict: 'not_submitted', submission_attempt_id: heldNow.id };
    await trx('seo_link_prospects').where({ id: p.id }).update({ attempts: 3 });
    assert.equal((await negative(verdict)).code, 200);
    assert.equal((await trx('seo_link_prospects').where({ id: p.id }).first()).attempts, 3);
    assert.equal((await trx('seo_link_prospects').where({ id: p.id }).first()).automation_policy, null);
    assert.equal((await negative(verdict)).code, 409);
    assert.equal((await trx('seo_link_attempts').where({ id: heldNow.id }).first()).outcome, 'slot_released');
    assert.equal((await trx('audit_log').where({ action: 'backlink.submission.not_submitted', resource_id: p.id })).length, 1);
    console.log('PASS negative owner verdict is audited and stale/replayed verdicts refuse');

    // Pre-submit failures release capacity while retaining a real investigator-visible failure.
    const failureLease = new Date(), failureId = randomUUID();
    const currentPlacement = await trx('seo_link_prospects').where({ id: p.id }).first();
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'prospect', claimed_at: failureLease, lease_mode: 'acquire', leased_provider: 'deterministic_runner', attempts: 0 });
    await trx('seo_link_attempts').insert({ id: failureId, prospect_id: p.id, path_id: currentPlacement.path_id, provider: 'deterministic_runner', action: 'submit', outcome: 'slot_reserved', lease_token: failureLease.toISOString(), idempotency_key: 'synthetic-failure', detail: { authority_id: authority.id } });
    assert.equal((await W.report({ prospect_id: p.id, provider: 'deterministic_runner', lease_token: failureLease.toISOString(), outcome: 'failed', error_code: 'field_action_failed' })).ok, true);
    const failed = await trx('seo_link_attempts').where({ id: failureId }).first();
    assert.equal(failed.outcome, 'failed'); assert.equal(failed.idempotency_key, null); assert.equal(failed.detail.error_code, 'field_action_failed');
    console.log('PASS pre-submit failure releases idempotency key and retains failure evidence');

    // Verification/baseline/recovery all use registry settlement after clearing a lease.
    for (const [before, after] of [['slot_reserved', 'slot_released'], ['submitting', 'submit_ambiguous']]) {
      const attemptId = randomUUID();
      await trx('seo_link_attempts').insert({ id: attemptId, prospect_id: p.id, path_id: currentPlacement.path_id, provider: 'deterministic_runner', action: 'submit', outcome: before });
      await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'live', claimed_at: null });
      await require(`${root}/server/services/seo/link-registry`).settleRetiredPlacements(trx, { prospectIds: [p.id] });
      assert.equal((await trx('seo_link_attempts').where({ id: attemptId }).first()).outcome, after);
    }
    console.log('PASS shared unleased settlement frees reservations and quarantines started submissions');




  } finally { await trx.rollback(); }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.destroy());
