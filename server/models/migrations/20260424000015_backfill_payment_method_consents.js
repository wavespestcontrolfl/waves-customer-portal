/**
 * Backfill consent rows for every existing payment_methods record so the
 * ledger has a baseline row for every card-on-file.
 *
 * These rows are intentionally tagged with version 'v0_implicit_pre_consent'
 * and a snapshot that spells out that no explicit authorization text was
 * shown at time of save — we do NOT want to retroactively claim the
 * customer saw the v1 copy they did not see. They serve as a "this card
 * existed before the consent ledger" audit anchor, not as proof of
 * informed consent.
 */

const IMPLICIT_VERSION = 'v0_implicit_pre_consent';
const IMPLICIT_SNAPSHOT = [
  'Pre-consent-system save — no explicit authorization text was shown',
  'to the customer at the time this payment method was saved. This row',
  'exists as a baseline audit anchor; it is NOT evidence of informed',
  'authorization under the v1 consent flow.',
].join(' ');

exports.up = async function (knex) {
  // Insert one row per existing payment_methods record that doesn't
  // already have a consent row pointing at it.
  const orphanCards = await knex('payment_methods as pm')
    .leftJoin('payment_method_consents as pmc', 'pmc.payment_method_id', 'pm.id')
    .whereNull('pmc.id')
    .whereNotNull('pm.stripe_payment_method_id')
    .select('pm.id', 'pm.customer_id', 'pm.stripe_payment_method_id', 'pm.created_at');

  if (orphanCards.length === 0) return;

  const rows = orphanCards.map((c) => ({
    customer_id: c.customer_id,
    payment_method_id: c.id,
    stripe_payment_method_id: c.stripe_payment_method_id,
    source: 'backfill',
    consent_text_version: IMPLICIT_VERSION,
    consent_text_snapshot: IMPLICIT_SNAPSHOT,
    // Anchor created_at to when the card was saved so audit queries
    // against payment_method_consents.created_at don't all bunch on
    // the deploy timestamp.
    created_at: c.created_at || new Date(),
  }));

  // Chunk for large datasets
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await knex('payment_method_consents').insert(rows.slice(i, i + CHUNK));
  }
};

exports.down = async function (knex) {
  await knex('payment_method_consents').where({ consent_text_version: IMPLICIT_VERSION }).del();
};
