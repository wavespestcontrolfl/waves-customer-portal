// Admin bell follow-ups (#4676 / #4677 audit, owner ruling 2026-09-24).
//
// 1. accepted-schedule alerts moved from a per-evidence dedupe key
//    (`accepted-schedule:<estimate>:<family>:<evidenceHash>`) to a stable
//    key (`accepted-schedule:<estimate>:<family>`) with the hash carried as
//    metadata.dedupeVersion (#4677). Without this backfill every open gap
//    rings once more under the new key and the old duplicates stay unread.
//    For each stable key: the NEWEST unresolved row becomes the standing row
//    (re-keyed, versioned) and its older duplicates are marked read.
// 2. job_complete is quietByDefault now (13% of those bells were ever
//    opened): existing preference rows for it go off on bell, push and sound.
//
// Fires ZERO customer communications: pure SQL on notifications and
// notification_preferences. `up` records prior values in audit_log
// (actor_type 'system'); `down` restores exactly those rows.
const AUDIT_ACTION = 'migration.admin_bell_followups';
const AUDIT_ROLLBACK_ACTION = 'migration.admin_bell_followups_rolled_back';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;

  // --- 1. accepted-schedule rows -------------------------------------------
  const rows = await knex('notifications')
    .where({ recipient_type: 'admin', category: 'alert' })
    .whereRaw("metadata->>'dedupeKey' LIKE 'accepted-schedule:%'")
    .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
    .select('id', 'read_at', 'created_at', knex.raw("metadata->>'dedupeKey' AS dedupe_key"));

  const byStableKey = new Map();
  for (const row of rows) {
    const parts = String(row.dedupe_key || '').split(':');
    // Rows already on the stable 3-part key carry no evidence suffix to lift.
    if (parts.length < 4) continue;
    const stableKey = parts.slice(0, 3).join(':');
    const evidence = parts.slice(3).join(':');
    if (!byStableKey.has(stableKey)) byStableKey.set(stableKey, []);
    byStableKey.get(stableKey).push({ ...row, stableKey, evidence });
  }

  const rekeyed = [];
  const markedRead = [];
  for (const group of byStableKey.values()) {
    group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const [newest, ...older] = group;
    await knex('notifications').where({ id: newest.id }).update({
      metadata: knex.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ dedupeKey: newest.stableKey, dedupeVersion: newest.evidence }),
      ]),
    });
    rekeyed.push({ id: newest.id, priorDedupeKey: newest.dedupe_key });
    const unreadOlder = older.filter((r) => !r.read_at).map((r) => r.id);
    if (unreadOlder.length) {
      await knex('notifications').whereIn('id', unreadOlder).whereNull('read_at').update({ read_at: knex.fn.now() });
      markedRead.push(...unreadOlder);
    }
  }

  // --- 2. job_complete preferences -----------------------------------------
  let prefPrior = [];
  if (await knex.schema.hasTable('notification_preferences')) {
    prefPrior = await knex('notification_preferences')
      .where({ trigger_key: 'job_complete' })
      .select('id', 'bell_enabled', 'push_enabled', 'sound_enabled');
    if (prefPrior.length) {
      await knex('notification_preferences')
        .where({ trigger_key: 'job_complete' })
        .update({ bell_enabled: false, push_enabled: false, sound_enabled: false, updated_at: knex.fn.now() });
    }
  }

  console.log(`[20260924000001] accepted-schedule: ${rekeyed.length} standing row(s) re-keyed, ${markedRead.length} duplicate(s) marked read; job_complete prefs quieted: ${prefPrior.length}`);
  if (await knex.schema.hasTable('audit_log')) {
    await knex('audit_log').insert({
      actor_type: 'system',
      action: AUDIT_ACTION,
      resource_type: 'notifications',
      metadata: JSON.stringify({ rekeyed, markedRead, prefPrior }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const entry = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first();
  if (!entry) return;
  const details = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : (entry.metadata || {});
  for (const r of details.rekeyed || []) {
    await knex('notifications').where({ id: r.id }).update({
      metadata: knex.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeVersion') || ?::jsonb", [JSON.stringify({ dedupeKey: r.priorDedupeKey })]),
    });
  }
  if ((details.markedRead || []).length) {
    await knex('notifications').whereIn('id', details.markedRead).update({ read_at: null });
  }
  for (const p of details.prefPrior || []) {
    await knex('notification_preferences').where({ id: p.id }).update({
      bell_enabled: p.bell_enabled, push_enabled: p.push_enabled, sound_enabled: p.sound_enabled, updated_at: knex.fn.now(),
    });
  }
  await knex('audit_log').insert({
    actor_type: 'system',
    action: AUDIT_ROLLBACK_ACTION,
    resource_type: 'notifications',
    metadata: JSON.stringify({ restored: details }),
  });
};
