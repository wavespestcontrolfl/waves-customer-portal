/**
 * Allow readable branded short-code aliases such as
 * /l/wpc-2026-0042-0507-k3j9.
 *
 * Existing short random codes keep working. The random suffix remains the
 * unguessable secret; invoice number/date are only human-readable context.
 */

exports.up = async function (knex) {
  await knex.raw('ALTER TABLE short_codes ALTER COLUMN code TYPE varchar(80)');
};

exports.down = async function (knex) {
  // Deliberately do not narrow back to varchar(16): once readable aliases
  // exist, truncating or rejecting them would break customer-facing links
  // and can make rollback fail. The wider column is backward-compatible
  // with legacy random short codes.
  await knex.raw('SELECT 1');
};
