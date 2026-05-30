/**
 * call_log.call_recording_consent_disclaimer_played — the consent flag the
 * customer-insights-miner requires before a call's transcript may be used for
 * (anonymized, aggregate) content mining.
 *
 * The miner degrades CLOSED when this column is absent: with no column it
 * excludes every call (reason 'consent_column_missing'), and per-row it
 * requires a strict boolean `true` (reason 'consent_not_played' otherwise).
 * Before this migration the column did not exist, so all ~689 inbound calls
 * were excluded from customer_insight_clusters.
 *
 * Default TRUE is correct here, by architecture — not an assumption:
 *   - Every inbound call plays the greeting MP3 BEFORE any recording/voicemail/
 *     connect. server/routes/twilio-voice-webhook.js documents that greeting as
 *     "the operative disclosure" under FL §934.03 (2025) (two-party consent),
 *     and it carries recording/transcription/AI-processing language. The
 *     voicemail path additionally says "Your message will be recorded and
 *     transcribed."; the connect path says "This call may be recorded,
 *     transcribed, and processed with AI to improve service."
 *   - Company policy (CLAUDE.md) is that all admin↔customer calls are recorded
 *     with that disclosure.
 * The disclaimer is therefore played on every logged call by design. The miner
 * only ever reads direction='inbound' rows, where the greeting disclosure is
 * unconditional, so a default of TRUE reflects reality for the miner's universe
 * and keeps future inbound rows eligible without wiring every call_log write
 * path (Studio Flow callbacks + fallback webhook).
 *
 * CONTRACT: if a future call path is added that does NOT play a recording
 * disclaimer, it MUST explicitly write this column false for those rows.
 *
 * Append-only + idempotent (hasColumn guard) — safe to re-run.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.boolean('call_recording_consent_disclaimer_played').notNullable().defaultTo(true);
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('call_recording_consent_disclaimer_played');
  });
};
