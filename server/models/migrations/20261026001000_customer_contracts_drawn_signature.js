/**
 * Drawn (hand-written) e-signature on customer contracts.
 *
 * The /contract/:token signing page has always captured a TYPED signature
 * (signed_name + recipient_initials + the consent checkboxes). Customers and
 * commercial property managers expect to see a drawn signature on the executed
 * copy, so the page now also offers a signature pad. The typed name stays
 * required and remains the legal signature of record; the drawn image is
 * additional evidence stamped into the PDF's signature block.
 *
 * One additive, nullable column on customer_contracts, shaped like the WDO
 * licensee signature (projects.wdo_signature, 20260529000004):
 *
 *   signature_image — text, a PNG or JPEG data URL the sign route validated
 *                     (type, size, magic bytes, visible ink). Null when the
 *                     signer typed only.
 *
 * Guarded with hasTable/hasColumn so this is safe to run more than once and
 * safe on a database predating customer_contracts.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_contracts'))) return;
  if (!(await knex.schema.hasColumn('customer_contracts', 'signature_image'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.text('signature_image');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_contracts'))) return;
  if (await knex.schema.hasColumn('customer_contracts', 'signature_image')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('signature_image');
    });
  }
};
