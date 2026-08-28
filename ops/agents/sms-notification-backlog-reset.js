// MUTATES (dry-run default): one-time reset of the inbound-SMS notification
// backlog so the bell / app-icon badge and the Messages "Unread" chip only
// count conversations that still want an answer. Three passes, all
// idempotent, no deletes:
//   1. messages (inbound sms, unread) whose body is a tapback reaction or a
//      pure courtesy closer (same detectors the webhook now applies on
//      arrival — server/services/sms-intent) → is_read=true.
//   2. inbound_sms bell notifications whose thread has NO remaining unread
//      inbound message → read_at=now (mirrors the thread-open cross-clear in
//      PUT /admin/communications/messages/read).
//   3. OPTIONAL, only with --stale-days=N: any unread inbound sms message and
//      any unread inbound_sms notification older than N days → read.
// Reversible: rows touched by this run carry the tag in
// messages.metadata->>'backlog_reset' / notifications.metadata->>'backlog_reset'.
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/sms-notification-backlog-reset.js                 # dry run
//   railway run --service Postgres node ops/agents/sms-notification-backlog-reset.js --execute
//   ... --execute --stale-days=30
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/sms-notification-backlog-reset.js');
  process.exit(1);
}
const path = require('path');
const { Client } = require('pg');
const { isSmsReaction, isCourtesyOnly } = require(path.join(__dirname, '..', '..', 'server', 'services', 'sms-intent'));

const execute = process.argv.includes('--execute');
const staleArg = process.argv.find((a) => a.startsWith('--stale-days='));
const staleDays = staleArg ? Number(staleArg.split('=')[1]) : null;
if (staleArg && !(Number.isInteger(staleDays) && staleDays >= 7)) {
  console.error('--stale-days must be an integer >= 7');
  process.exit(1);
}
const etStamp = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').replace(/:/g, '');
const tag = `sms-backlog-reset-${etStamp}-${require('crypto').randomBytes(3).toString('hex')}`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'} tag=${tag}${staleDays ? ` stale-days=${staleDays}` : ''}`);

  // Pass 1 — classify unread inbound bodies in Node (the detectors are JS).
  const unread = await c.query(`SELECT id, body FROM messages WHERE channel='sms' AND direction='inbound' AND (is_read IS NOT TRUE)`);
  const closers = unread.rows.filter((r) => isSmsReaction(r.body) || isCourtesyOnly(r.body)).map((r) => r.id);
  console.log(`unread inbound sms messages: ${unread.rows.length}; reaction/courtesy closers: ${closers.length}`);

  // Pass 3 (optional) — stale rows.
  let staleMsgs = { rows: [] }; let staleBells = { rows: [] };
  if (staleDays) {
    staleMsgs = await c.query(`SELECT id FROM messages WHERE channel='sms' AND direction='inbound' AND (is_read IS NOT TRUE) AND created_at < now() - ($1::int * interval '1 day')`, [staleDays]);
    staleBells = await c.query(`SELECT id FROM notifications WHERE category='inbound_sms' AND read_at IS NULL AND created_at < now() - ($1::int * interval '1 day')`, [staleDays]);
    console.log(`stale (>${staleDays}d): unread messages ${staleMsgs.rows.length}, unread inbound_sms bells ${staleBells.rows.length}`);
  }

  if (!execute) {
    // Pass 2 preview must account for what passes 1/3 would read.
    const wouldRead = new Set([...closers, ...staleMsgs.rows.map((r) => r.id)]);
    const orphanBells = await c.query(`
      SELECT n.id FROM notifications n
      WHERE n.category='inbound_sms' AND n.read_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE m.channel='sms' AND m.direction='inbound' AND (m.is_read IS NOT TRUE)
            AND n.link = '/admin/communications?thread=' || cv.customer_id::text
            AND NOT (m.id = ANY($1::uuid[]))
        )`, [[...wouldRead]]);
    console.log(`inbound_sms bells with no remaining unread message (would clear): ${orphanBells.rows.length}`);
    console.log('dry run — nothing written. Re-run with --execute to apply.');
    await c.end();
    return;
  }

  await c.query('BEGIN');
  const stamp = `jsonb_build_object('backlog_reset', $1::text)`;
  const readMsgs = async (idList, label) => {
    if (!idList.length) return 0;
    const r = await c.query(`UPDATE messages SET is_read=true, read_at=now(), updated_at=now(), metadata = COALESCE(metadata,'{}'::jsonb) || ${stamp} WHERE id = ANY($2::uuid[]) AND (is_read IS NOT TRUE)`, [tag, idList]);
    console.log(`${label}: marked ${r.rowCount} messages read`);
    return r.rowCount;
  };
  await readMsgs(closers, 'pass 1 (reaction/courtesy)');
  if (staleDays) {
    await readMsgs(staleMsgs.rows.map((r) => r.id), `pass 3 (stale >${staleDays}d messages)`);
    const rb = await c.query(`UPDATE notifications SET read_at=now(), metadata = COALESCE(metadata,'{}'::jsonb) || ${stamp} WHERE category='inbound_sms' AND read_at IS NULL AND created_at < now() - ($2::int * interval '1 day')`, [tag, staleDays]);
    console.log(`pass 3 (stale bells): marked ${rb.rowCount} notifications read`);
  }
  const r2 = await c.query(`
    UPDATE notifications n SET read_at=now(), metadata = COALESCE(n.metadata,'{}'::jsonb) || ${stamp}
    WHERE n.category='inbound_sms' AND n.read_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.channel='sms' AND m.direction='inbound' AND (m.is_read IS NOT TRUE)
          AND n.link = '/admin/communications?thread=' || cv.customer_id::text)`, [tag]);
  console.log(`pass 2 (bells with no unread message): marked ${r2.rowCount} notifications read`);
  await c.query('COMMIT');
  console.log(`done. Rollback one batch: UPDATE messages SET is_read=false, read_at=NULL WHERE metadata->>'backlog_reset'='${tag}'; UPDATE notifications SET read_at=NULL WHERE metadata->>'backlog_reset'='${tag}';`);
  await c.end();
})().catch(async (e) => { console.error(e.message); process.exit(1); });
