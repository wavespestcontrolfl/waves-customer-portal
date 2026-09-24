/**
 * Round-trip safety companion to 20260924000110_customer_photo_id_mode_rollback.js
 * — which is ITSELF now frozen (already pushed to origin as part of PR
 * #4752), so per .claude/skills/waves-db §4 this is a NEW migration rather
 * than an edit to that file.
 *
 * THE GAP (codex GH r1 P1): 20260924000110's down() flips every
 * mode='customer' row to 'internal' so the older 20260924000100's down()
 * can narrow its CHECK constraint back. If the schema is later REAPPLIED
 * (migrate:latest again after that rollback), nothing ever flipped those
 * rows back to 'customer' — 20260924000110's own up() is a documented
 * no-op. Those rows would then stay 'internal' forever, invisible to
 * server/routes/photo-id.js's GET / and GET /:type/:id, which both filter
 * on mode='customer' — a real customer's Photo ID history permanently
 * disappearing after an operator rolls back and reapplies.
 *
 * THE FIX: this migration's up() restores them. `source='portal'` is the
 * ONLY value either pest_identifications or lawn_diagnostics ever gets from
 * server/routes/photo-id.js (prospect-funnel rows use 'public_funnel', tech
 * rows use 'tech', admin-created rows use 'admin' — see
 * 20260707000030_prospect_photo_assessments.js and
 * admin-photo-assessments.js), so it losslessly and unambiguously
 * identifies exactly the rows 20260924000110's down() would have touched,
 * whether or not a rollback ever actually ran (idempotent either way).
 *
 * ORDERING: on a real rollback, migrations run newest-stamp-first — this
 * file's down() (a no-op; nothing to undo) runs before 20260924000110's
 * down() (the customer→internal remap), before 20260924000100's down() (the
 * CHECK narrowing). On reapply, migrations run oldest-stamp-first —
 * 20260924000100's up() (re-widens the CHECK to allow 'customer' again)
 * runs before 20260924000110's up() (still a no-op) runs before THIS file's
 * up() (the restore), so the wider CHECK is already back in place by the
 * time this UPDATE executes.
 *
 * tree_shrub_assessments has no mode CHECK constraint at all (20260924000100
 * added the column as a plain string), so its 'customer' rows were never at
 * risk from a rollback and need no restore here.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pest_identifications')) {
    await knex('pest_identifications').where({ source: 'portal' }).update({ mode: 'customer' });
  }
  if (await knex.schema.hasTable('lawn_diagnostics')) {
    await knex('lawn_diagnostics').where({ source: 'portal' }).update({ mode: 'customer' });
  }
};

exports.down = async function down() {
  // No-op by design — see header. This migration's whole job is a forward
  // restore; the migration that actually performs the customer→internal
  // remap (and whose down() this protects) is 20260924000110.
};
