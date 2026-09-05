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
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token }), false);
    gates.add('linkAuthority');
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token }), true);
    assert.equal(await E.beginSubmission(proxy, { prospectId: p.id, leaseToken: p.lease_token }), false);
    assert.equal((await W.report({ prospect_id: p.id, provider: 'hermes', lease_token: p.lease_token, outcome: 'placed', pending: true })).code, 'stale_lease');
    assert.equal((await W.report({ prospect_id: p.id, provider: 'deterministic_runner', lease_token: p.lease_token, outcome: 'placed', pending: true })).ok, true);
    const stored = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(stored.status, 'placed');
    assert.equal((await trx('seo_link_placement_authorities').where({ prospect_id: p.id, dimension: 'execution' }).first()).satisfied_reason, 'placed');
    console.log('PASS bridge → one capped lease → kill/replay/provider refusals → pending placement and authority settlement');
    await trx('seo_link_acquisition_paths').where({ id: pathId }).update({ acquisition_type: 'content_submission', link_type: 'editorial', execution_after_send: false });
    await trx('seo_link_prospects').where({ id: p.id }).update({ status: 'live', link_type: 'editorial', attempts: 2 });
    const [draftLease] = await W.claim({ type: 'outreach', mode: 'draft', provider: 'hermes', domains: [domain] });
    assert.ok(draftLease);
    assert.equal((await W.report({ prospect_id: p.id, provider: 'hermes', lease_token: draftLease.lease_token, outcome: 'skipped' })).ok, true);
    const afterDraft = await trx('seo_link_prospects').where({ id: p.id }).first();
    assert.equal(afterDraft.status, 'live'); assert.equal(afterDraft.attempts, 2); assert.equal(afterDraft.outreach_draft_attempts, W.MAX_ATTEMPTS);
    assert.deepEqual(await W.claim({ type: 'outreach', mode: 'draft', provider: 'hermes', domains: [domain] }), []);
    console.log('PASS skipped late pitch preserves live lifecycle and acquisition attempts, then stops reclaiming');
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
    const router = require(`${root}/server/routes/admin-backlink-agent-v2`);
    const edit = router.stack.find(l => l.route?.path === '/prospects/:id' && l.route.methods.patch).route.stack.at(-1).handle;
    const confirm = () => new Promise((resolve, reject) => edit({ params: { id: p.id }, body: { status: 'placed', live_url: `https://${domain}/confirmed` } }, { json: resolve, status(code) { return { json: body => reject(Error(`${code}: ${JSON.stringify(body)}`)) }; } }, reject));
    assert.equal((await confirm()).prospect.status, 'placed');
    assert.equal((await trx('seo_link_attempts').where({ id: rejectedAttempt }).first()).outcome, 'placed');
    assert.equal((await trx('seo_link_placement_authorities').where({ id: authority.id }).first()).satisfied_reason, 'placed');
    await confirm();
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



  } finally { await trx.rollback(); }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.destroy());
