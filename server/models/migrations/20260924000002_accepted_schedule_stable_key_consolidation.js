// Supersedes the accepted-schedule half of 20260924000001 (pre-push audit P1,
// migration-guard: that file is already on the branch, so it stays as-is).
//
// 20260924000001 re-keyed only LEGACY rows (`accepted-schedule:<est>:<fam>:
// <evidence>`) and skipped rows already on the stable 3-part key. But #4677
// is live, so the watchdog may already have minted a stable-key row beside
// the legacy ones — after 000001 two unresolved rows can share one stable
// key, and notifyAdmin's `.first()` probe would pick an arbitrary one.
//
// This pass groups BOTH shapes under the stable key: the newest unresolved
// row stands (stable dedupeKey, evidence in metadata.dedupeVersion); every
// other row in the group is marked read and loses its ACTIVE dedupeKey so
// exactly one row answers the probe. Idempotent: a group of one stable row is
// a no-op rewrite. Zero customer communications. Prior values go to
// audit_log (actor_type 'system'); `down` restores exactly those rows.
const AUDIT_ACTION = 'migration.accepted_schedule_stable_key_consolidation';
const AUDIT_ROLLBACK_ACTION = 'migration.accepted_schedule_stable_key_consolidation_rolled_back';
const STABLE_KEY_PARTS = 3; // accepted-schedule:<estimateId>:<family>

function splitKey(dedupeKey) {
  const parts = String(dedupeKey || '').split(':');
  if (parts.length < STABLE_KEY_PARTS) return null;
  return {
    stableKey: parts.slice(0, STABLE_KEY_PARTS).join(':'),
    // Legacy keys carry the evidence hash in the key; stable rows carry it
    // (if at all) in metadata.dedupeVersion, selected separately below.
    keyEvidence: parts.length > STABLE_KEY_PARTS ? parts.slice(STABLE_KEY_PARTS).join(':') : null,
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;

  const rows = await knex('notifications')
    .where({ recipient_type: 'admin', category: 'alert' })
    .whereRaw("metadata->>'dedupeKey' LIKE 'accepted-schedule:%'")
    .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
    .select('id', 'read_at', 'created_at',
      knex.raw("metadata->>'dedupeKey' AS dedupe_key"),
      knex.raw("metadata->>'dedupeVersion' AS dedupe_version"));

  const byStableKey = new Map();
  for (const row of rows) {
    const split = splitKey(row.dedupe_key);
    if (!split) continue;
    if (!byStableKey.has(split.stableKey)) byStableKey.set(split.stableKey, []);
    byStableKey.get(split.stableKey).push({ ...row, ...split });
  }

  const standing = []; // { id, priorDedupeKey, priorDedupeVersion }
  const retired = [];  // { id, priorDedupeKey, wasUnread }
  for (const group of byStableKey.values()) {
    group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const [newest, ...older] = group;
    const version = newest.keyEvidence || newest.dedupe_version || null;
    await knex('notifications').where({ id: newest.id }).update({
      metadata: knex.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ dedupeKey: newest.stableKey, ...(version ? { dedupeVersion: version } : {}) }),
      ]),
    });
    standing.push({ id: newest.id, priorDedupeKey: newest.dedupe_key, priorDedupeVersion: newest.dedupe_version || null });
    for (const dup of older) {
      // Superseded by the standing row: read, and no active probe key. opsKey
      // and payload stay for history.
      await knex('notifications').where({ id: dup.id }).update({
        metadata: knex.raw("COALESCE(metadata, '{}'::jsonb) - 'dedupeKey'"),
        ...(dup.read_at ? {} : { read_at: knex.fn.now() }),
      });
      retired.push({ id: dup.id, priorDedupeKey: dup.dedupe_key, wasUnread: !dup.read_at });
    }
  }

  console.log(`[20260924000002] accepted-schedule: ${standing.length} standing row(s), ${retired.length} duplicate(s) retired (${retired.filter((r) => r.wasUnread).length} were unread)`);
  if (await knex.schema.hasTable('audit_log')) {
    await knex('audit_log').insert({
      actor_type: 'system',
      action: AUDIT_ACTION,
      resource_type: 'notifications',
      metadata: JSON.stringify({ standing, retired }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const entry = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first();
  if (!entry) return;
  const details = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : (entry.metadata || {});
  for (const s of details.standing || []) {
    await knex('notifications').where({ id: s.id }).update({
      metadata: knex.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeVersion') || ?::jsonb", [
        JSON.stringify({ dedupeKey: s.priorDedupeKey, ...(s.priorDedupeVersion ? { dedupeVersion: s.priorDedupeVersion } : {}) }),
      ]),
    });
  }
  for (const r of details.retired || []) {
    await knex('notifications').where({ id: r.id }).update({
      metadata: knex.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ dedupeKey: r.priorDedupeKey })]),
      ...(r.wasUnread ? { read_at: null } : {}),
    });
  }
  await knex('audit_log').insert({
    actor_type: 'system',
    action: AUDIT_ROLLBACK_ACTION,
    resource_type: 'notifications',
    metadata: JSON.stringify({ restored: details }),
  });
};
