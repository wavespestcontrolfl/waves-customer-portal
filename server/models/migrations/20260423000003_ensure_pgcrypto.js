/**
 * Defensive pgcrypto ensure — runs unconditionally on every deploy so
 * future migrations (and any SQL that calls gen_random_bytes / crypt /
 * digest / etc.) can rely on the extension being present.
 *
 * Idempotent. If pgcrypto is already installed, no-op. If prod's
 * extension gets dropped again for any reason (DB reprovision, major
 * version upgrade without re-enabling, accidental DROP EXTENSION),
 * this file's timestamp is forward of all extant migrations — on next
 * deploy it reinstalls.
 *
 * Also edits 20260422000009_scheduled_services_tracking.js to ensure
 * pgcrypto in its own exports.up (for the case where 000009 hasn't
 * been applied yet on an env that also lost pgcrypto). This migration
 * is the safety net for environments that already applied 000009 but
 * then lost the extension.
 */
exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
};

exports.down = async function () {
  // Intentional no-op. Never drop pgcrypto in a rollback — other code
  // unrelated to this migration depends on it.
};
