/**
 * projects.wdo_signature — captured licensee e-signature for WDO inspection
 * reports. A WDO report is an official FDACS-13645 filing that must carry the
 * licensee/cardholder signature (Rule 5E-14.142, F.A.C.), so the report send is
 * gated on this being present and the signature image is stamped into the
 * form's signature field before flattening.
 *
 * JSONB shape: { image (data URL), content_type, signer_name, signer_id_card,
 * attestation, signed_at, signed_by_tech_id }. Nullable.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_signature');
  if (has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.jsonb('wdo_signature');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_signature');
  if (!has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('wdo_signature');
  });
};
