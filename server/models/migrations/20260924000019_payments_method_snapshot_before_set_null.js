/**
 * Ordering guard (GH codex r6 P2): the tender-snapshot columns and the
 * BEFORE DELETE trigger must exist BEFORE 20260924000021 flips
 * payments.payment_method_id to ON DELETE SET NULL. Knex commits each
 * migration on its own while the previous app is still serving, so a
 * method removed between 000021 and 000032 would null the link with no
 * snapshot, and the later backfills (which join on that link) could not
 * recover it.
 *
 * 000021 and 000032 were already pushed (frozen), so this sorts ahead of
 * 000021 and runs 000032's idempotent up() — ADD COLUMN only when
 * missing, fill-only backfill, CREATE OR REPLACE FUNCTION, DROP TRIGGER
 * IF EXISTS + CREATE TRIGGER. 000032 re-running later is a no-op, and on
 * a database that already ran 000032 this one is too. down() is a no-op:
 * 000032's down() owns removing the trigger and columns.
 */
const snapshotOnDelete = require('./20260924000032_payments_method_snapshot_on_delete');

exports.up = snapshotOnDelete.up;

exports.down = async function down() {};
