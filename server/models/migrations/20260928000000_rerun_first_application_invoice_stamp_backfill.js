/**
 * Re-runs backfillFirstApplicationInvoiceStamps (Codex round-9 P1 on
 * #5021's frozen migration 20260927220000) with the WIDENED sibling
 * eligibility now in estimate-first-application-invoice.js: the original
 * migration's backfill required a sibling's CURRENT scheduled_date to
 * still match the anchor's — so a historical pair that had ALREADY
 * diverged onto different days before 20260927220000 ever ran (the exact
 * state this whole feature exists to surface) was never stamped, and has
 * stayed permanently invisible to the sibling-split sweep ever since.
 * backfillFirstApplicationInvoiceStamps now also accepts acceptance-time
 * evidence (a shared created_at instant, or reschedule_log proof the
 * sibling once sat on the anchor's date) — see its own doc comment.
 *
 * NO SCHEMA CHANGE here — 20260927220000 already added the column and is
 * pushed and frozen, never edited by this migration or any other. This
 * migration exists solely so a database that already ran the frozen
 * migration (and therefore already has the column, already backfilled
 * under the OLD, narrower rule) picks up the wider backfill too, without
 * touching the frozen migration file. Idempotent and safe to run any
 * number of times: backfillFirstApplicationInvoiceStamps recomputes the
 * same deterministic mapping from current live state each time and
 * overwrites with the same value — this migration's own `up` never
 * inspects or depends on the frozen migration's prior run in any way
 * beyond the column already existing (guarded by the same hasColumn check
 * the shared function itself does, so this is a safe no-op on a database
 * where the frozen migration hasn't run yet either, e.g. a brand-new test
 * database that runs every migration in order — the frozen migration
 * above it in migration order will have already created the column and
 * run the narrower backfill by the time this one runs).
 */

exports.up = async function up(knex) {
  const { backfillFirstApplicationInvoiceStamps } = require('../../services/estimate-first-application-invoice');
  await backfillFirstApplicationInvoiceStamps(knex);
};

// No schema change was made — nothing to roll back. A future migration
// run of this same backfill logic (it is idempotent and always
// recomputes from current live state) is not something `down` should try
// to undo by clearing stamps; that would strip legitimate accept-time
// stamps written by stampCombinedFirstApplicationInvoiceCoverage since,
// which this migration never touches.
exports.down = async function down() {};
