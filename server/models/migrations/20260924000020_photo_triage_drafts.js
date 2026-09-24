/**
 * Photo-text auto-triage (services/photo-text-triage.js, GATE_PHOTO_TRIAGE).
 *
 * 1) messages.photo_triage_at — the one-triage-per-message claim. The
 *    triage stamps the inbound message row with a conditional
 *    UPDATE ... WHERE photo_triage_at IS NULL before it spends a vision
 *    call, so a replayed or concurrent run for the same message can never
 *    analyze twice. The same stamp is what the PHOTO_TRIAGE_DAILY_CAP count
 *    reads (claims per ET day), so the cap counts exactly the vision runs
 *    that were started. Nullable, no default: a metadata-only ALTER on
 *    Postgres 11+, no table rewrite. No new index — the cap count is range-
 *    scoped by the existing messages (channel, created_at DESC) index.
 *
 * 2) message_drafts insert guard — prod's BEFORE INSERT trigger
 *    (block_message_drafts_when_disabled) raises 'legacy_ai_drafts_disabled'
 *    unless the row matches an allowlisted shape. The triage parks its reply
 *    as status='pending', intent='photo_triage' for OWNER approval in
 *    /admin/drafts, so the intent joins the owner-review ARRAY the same way
 *    20260718400000 added 'estimate_clarify': SPLICE, DON'T CLOBBER — read
 *    the LIVE definition via pg_get_functiondef, append ONLY to the existing
 *    intent array, preserve every other clause. Unrecognized shape → fail
 *    loudly rather than guess. Function absent (a fresh replay ordering that
 *    cannot happen by timestamp) → no-op.
 */

const ARRAY_WITH_CLICK_FOLLOWUP_RE = /(ARRAY\[[^\]]*'click_followup'[^\]]*)\]::text\[\]/i;
const PHOTO_TRIAGE_ENTRY_RE = /,\s*'photo_triage'/i;

async function readLiveDefinition(knex) {
  const result = await knex.raw(`
    SELECT pg_get_functiondef(oid) AS def
    FROM pg_proc
    WHERE proname = 'block_message_drafts_when_disabled'
      AND pronamespace = 'public'::regnamespace
  `);
  const rows = result && result.rows ? result.rows : [];
  return rows.length ? rows[0].def : null;
}

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('messages', 'photo_triage_at');
  if (!hasColumn) {
    await knex.schema.alterTable('messages', (t) => {
      t.timestamp('photo_triage_at', { useTz: true }).nullable();
    });
  }

  const current = await readLiveDefinition(knex);
  if (!current || current.includes("'photo_triage'")) return;
  if (!ARRAY_WITH_CLICK_FOLLOWUP_RE.test(current)) {
    throw new Error(
      'block_message_drafts_when_disabled has no recognizable intent allowlist '
      + "(ARRAY[...'click_followup'...]::text[]) to extend; resolve manually",
    );
  }
  await knex.raw(current.replace(ARRAY_WITH_CLICK_FOLLOWUP_RE, "$1, 'photo_triage']::text[]"));
};

exports.down = async function down(knex) {
  const current = await readLiveDefinition(knex);
  if (current && PHOTO_TRIAGE_ENTRY_RE.test(current)) {
    await knex.raw(current.replace(PHOTO_TRIAGE_ENTRY_RE, ''));
  }
  const hasColumn = await knex.schema.hasColumn('messages', 'photo_triage_at');
  if (hasColumn) {
    await knex.schema.alterTable('messages', (t) => {
      t.dropColumn('photo_triage_at');
    });
  }
};

exports._private = { ARRAY_WITH_CLICK_FOLLOWUP_RE, PHOTO_TRIAGE_ENTRY_RE };
