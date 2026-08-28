/**
 * Step-1 backfills (plan v2 §3.4, §4). Both are pure functions of the database
 * they are handed (knex or trx) and re-runnable to a fixed point:
 *
 *  backfillLegacyAttempts(q) — copy every `seo_signup_attempts` row that has no
 *    twin in `seo_link_attempts` (keyed by legacy_attempt_id, partial UNIQUE).
 *    Runs in the migration, once at boot, and at the start of every signup-runner
 *    run(): a legacy row written by an OLD pod during the rolling deploy (after
 *    the migration, before the new writer is live) is picked up by the next
 *    catch-up, never lost. There is no dual-write.
 *
 *  backfillLegacyBoard(q) — every `seo_link_prospects` row gets a registry
 *    domain (grouped by canonical host; first-touch source = the earliest legacy
 *    row's mapped source), its own historical touch (seen_at = the row's
 *    created_at, never now()), and an acquisition path mapped from its lane;
 *    then domain_id / path_id are linked. Rows already linked are skipped.
 *
 * Neither inserts a board row, sends anything, or spends anything.
 */

const {
  mapLegacySource, acquisitionPathFromLegacyRow, attemptFromLegacyRow, ensureDomain,
} = require('./link-registry');
const { canonicalProspectDomain } = require('./prospect-domain-lock');

const ATTEMPT_BATCH = 500;

async function backfillLegacyAttempts(q, { log = null } = {}) {
  if (!(await q.schema.hasTable('seo_signup_attempts'))) return { copied: 0, scanned: 0 };
  let copied = 0;
  let scanned = 0;
  for (;;) {
    // Legacy rows with no twin yet. LEFT JOIN on the partial-unique key; the
    // insert below ignores conflicts so a concurrent catch-up is harmless.
    const rows = await q('seo_signup_attempts as a')
      .leftJoin('seo_link_attempts as la', 'la.legacy_attempt_id', 'a.id')
      .leftJoin('seo_link_prospects as p', 'p.id', 'a.prospect_id')
      .whereNull('la.id')
      .orderBy('a.created_at', 'asc').orderBy('a.id', 'asc')
      .limit(ATTEMPT_BATCH)
      .select('a.*', 'p.path_id as prospect_path_id');
    if (!rows.length) break;
    scanned += rows.length;
    const payload = rows.map((a) => attemptFromLegacyRow(a, { pathId: a.prospect_path_id }));
    const inserted = await q('seo_link_attempts').insert(payload)
      .onConflict(q.raw('(legacy_attempt_id) WHERE legacy_attempt_id IS NOT NULL')).ignore()
      .returning(['id']);
    copied += inserted ? inserted.length : 0;
    if (rows.length < ATTEMPT_BATCH) break;
  }
  if (log && (copied || scanned)) log(`[link-registry] legacy attempts catch-up: scanned=${scanned} copied=${copied}`);
  return { copied, scanned };
}

async function findActivePath(q, domainId, key) {
  return q('seo_link_acquisition_paths').where({ domain_id: domainId, path_key: key }).whereNull('superseded_by').first('id');
}

async function backfillLegacyBoard(q, { log = null } = {}) {
  const rows = await q('seo_link_prospects')
    .orderBy('created_at', 'asc').orderBy('id', 'asc')
    .select('id', 'target_domain', 'target_url', 'link_type', 'source', 'source_ref', 'created_at',
      'domain_id', 'path_id', 'requires_account', 'requires_email_verification', 'requires_payment',
      'detected_price_usd', 'offered_link_rel');

  const groups = new Map();
  for (const r of rows) {
    const key = canonicalProspectDomain(r.target_domain);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = { domains: 0, domainsCreated: 0, touches: 0, paths: 0, linked: 0, skippedNoHost: rows.length - [...groups.values()].reduce((n, g) => n + g.length, 0) };
  for (const [host, group] of groups) {
    // rows arrive ordered by created_at, id — group[0] is the deterministic first touch
    const first = group[0];
    const firstTouch = mapLegacySource(first.source);
    const dom = await ensureDomain(q, {
      domain: host,
      source: firstTouch.source,
      sourceDetail: firstTouch.source_detail,
      sourceRef: first.source_ref || null,
      seenAt: first.created_at || null,
      createdAt: first.created_at || null,
    });
    out.domains += 1;
    if (dom.created) out.domainsCreated += 1;
    if (dom.touched) out.touches += 1;

    for (const r of group) {
      if (r !== first) {
        const m = mapLegacySource(r.source);
        const t = await ensureDomain(q, { domain: host, source: m.source, sourceDetail: m.source_detail, sourceRef: r.source_ref || null, seenAt: r.created_at || null });
        if (t.touched) out.touches += 1;
      }
      if (r.domain_id && r.path_id) continue;

      const path = acquisitionPathFromLegacyRow(r);
      let existing = await findActivePath(q, dom.id, path.path_key);
      if (!existing) {
        // Concurrent catch-ups (boot, runner, CLI) hold different locks: insert
        // against the partial unique index and reselect the winner on conflict.
        const ins = await q('seo_link_acquisition_paths').insert({ ...path, domain_id: dom.id })
          .onConflict(q.raw('(domain_id, path_key) WHERE superseded_by IS NULL')).ignore()
          .returning(['id']);
        if (ins && ins.length) { existing = ins[0]; out.paths += 1; }
        else existing = await findActivePath(q, dom.id, path.path_key);
        if (!existing) throw new Error(`link-registry: lost race creating path ${path.path_key} for ${host}`);
      }
      const patch = {};
      if (!r.domain_id) patch.domain_id = dom.id;
      if (!r.path_id) patch.path_id = existing.id;
      if (Object.keys(patch).length) {
        await q('seo_link_prospects').where({ id: r.id }).update({ ...patch, updated_at: q.fn ? q.fn.now() : new Date() });
        out.linked += 1;
      }
    }
  }
  if (log) log(`[link-registry] legacy board backfill: ${JSON.stringify(out)}`);
  return out;
}

module.exports = { backfillLegacyAttempts, backfillLegacyBoard, ATTEMPT_BATCH };
