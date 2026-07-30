/**
 * Codex rounds 12–14 on #3039: canonical account identity.
 *
 * The shared Google contact publishes customer_accounts values, so identity
 * edits must land there no matter which writer made them (admin PUT,
 * Intelligence Bar update_customer, data-hygiene auto-apply, ...). A DB
 * trigger propagates identity-field changes from ANY customers writer UP to
 * the canonical account row — covering every current and future writer
 * without per-route plumbing.
 *
 * Deliberately NO reverse fan-out trigger (accounts → bump all linked
 * customers): that inverted lock order (own customer row first, then the
 * account, then OTHER customer rows) and could deadlock concurrent property
 * edits. Linked rows are requeued instead by the sync's stale predicate,
 * which compares the ACCOUNT watermark directly.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_accounts')) || !(await knex.schema.hasTable('customers'))) return;
  const hasAuditLog = await knex.schema.hasTable('audit_log');
  // Remove the earlier reverse fan-out if a prior deploy created it.
  await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  await knex.raw('DROP FUNCTION IF EXISTS touch_linked_customers_on_account_identity()');
  // BACKFILL before the trigger goes live: identity edits made after the
  // account layer landed went to customers ONLY (the old admin path), so
  // account rows can hold obsolete identities that the sync would publish
  // as canonical. Reconcile each account from its most recently updated
  // LIVE customer; only rows that actually differ are touched.
  // Per-field hygiene provenance: data-hygiene auto-apply DOES write
  // account identity directly (data-hygiene/auto-apply.js,
  // NORMALIZATION_TABLES.customer_account) and audits every apply with the
  // specific field in metadata. An audited field keeps the ACCOUNT's value
  // (a property row bumped later for unrelated reasons must never revert a
  // hygiene fix); un-audited divergent fields still promote — an
  // account-wide exclusion would let one old phone cleanup freeze an
  // unrelated legacy name/email correction out of the backfill forever.
  // Hygiene provenance is authoritative only while it is the LATEST word
  // on the field: an audited apply older than the newest divergent copy's
  // updated_at is superseded by that later customer correction. (A legacy
  // no-bump admin save can't be ordered against the audit — the >= gate
  // below then lets the customer win, matching the pre-account-layer
  // reality that identity edits always landed on customers.)
  const auditedField = (f) => (hasAuditLog
    ? `EXISTS (
        SELECT 1 FROM audit_log al
        WHERE al.action = 'data_hygiene.proposal.apply'
          AND al.resource_type = 'customer_account'
          AND al.resource_id = ca.id
          AND al.metadata->>'field' = '${f}'
          AND al.created_at >= COALESCE((
            SELECT c.updated_at FROM customers c
            WHERE c.account_id = ca.id AND c.deleted_at IS NULL
              AND c.${f} IS DISTINCT FROM ca.${f}
              AND c.updated_at >= ca.updated_at
            ORDER BY c.updated_at DESC LIMIT 1), 'epoch'::timestamptz))`
    : 'FALSE');
  // PER-FIELD candidate selection: sibling A may hold a legacy email
  // correction while sibling B holds a later phone correction — a single
  // newest-divergent ROW would copy all four fields from B and revert or
  // miss A's email. Each field independently promotes from the newest
  // live copy that diverges in THAT field. The promoted value may be an
  // intentional NULL (a cleared email/phone), so eligibility — not
  // COALESCE — decides whether the account keeps its own value.
  const fieldEligible = (f) => `(EXISTS (
        SELECT 1 FROM customers c
        WHERE c.account_id = ca.id AND c.deleted_at IS NULL
          AND c.${f} IS DISTINCT FROM ca.${f}
          AND c.updated_at >= ca.updated_at)
        AND NOT ${auditedField(f)})`;
  const fieldPick = (f) => `CASE WHEN ${fieldEligible(f)} THEN (
        SELECT c.${f} FROM customers c
        WHERE c.account_id = ca.id AND c.deleted_at IS NULL
          AND c.${f} IS DISTINCT FROM ca.${f}
          AND c.updated_at >= ca.updated_at
        ORDER BY c.updated_at DESC LIMIT 1) ELSE ca.${f} END`;
  await knex.raw(`
    UPDATE customer_accounts ca SET
      first_name = ${fieldPick('first_name')},
      last_name  = ${fieldPick('last_name')},
      email      = ${fieldPick('email')},
      phone      = ${fieldPick('phone')},
      updated_at = now()
    -- Only accounts with at least one eligible field — a no-op update
    -- would still bump updated_at and needlessly requeue the account's
    -- rows through the sync's staleness predicate. Equality (>=) must
    -- qualify: the legacy admin path edited identity WITHOUT bumping
    -- customers.updated_at, so a single-property account seeded from its
    -- customer shares the exact timestamp while the customer holds the
    -- correction. An account STRICTLY newer than every divergent copy has
    -- no eligible candidates and is preserved.
    WHERE ${fieldEligible('first_name')}
       OR ${fieldEligible('last_name')}
       OR ${fieldEligible('email')}
       OR ${fieldEligible('phone')}
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION propagate_customer_identity_to_account() RETURNS trigger AS $$
    BEGIN
      -- Per-column: only the fields the writer actually CHANGED propagate.
      -- Copying all four would let a stale sibling's phone edit silently
      -- revert a newer canonical name/email correction.
      UPDATE customer_accounts SET
        first_name = CASE WHEN NEW.first_name IS DISTINCT FROM OLD.first_name THEN NEW.first_name ELSE first_name END,
        last_name  = CASE WHEN NEW.last_name  IS DISTINCT FROM OLD.last_name  THEN NEW.last_name  ELSE last_name  END,
        email      = CASE WHEN NEW.email      IS DISTINCT FROM OLD.email      THEN NEW.email      ELSE email      END,
        phone      = CASE WHEN NEW.phone      IS DISTINCT FROM OLD.phone      THEN NEW.phone      ELSE phone      END,
        updated_at = now()
      WHERE id = NEW.account_id;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await knex.raw('DROP TRIGGER IF EXISTS customers_identity_propagate ON customers');
  await knex.raw(`
    CREATE TRIGGER customers_identity_propagate AFTER UPDATE ON customers
    FOR EACH ROW
    WHEN (NEW.account_id IS NOT NULL
      -- Live rows only: dedupe retirement scrambles the loser's phone/email
      -- in the same update that sets deleted_at — those sentinel values
      -- must never overwrite the shared canonical identity.
      AND NEW.deleted_at IS NULL
      AND (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone IS DISTINCT FROM NEW.phone
        OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name))
    EXECUTE FUNCTION propagate_customer_identity_to_account();
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customers')) {
    await knex.raw('DROP TRIGGER IF EXISTS customers_identity_propagate ON customers');
  }
  await knex.raw('DROP FUNCTION IF EXISTS propagate_customer_identity_to_account()');
  if (await knex.schema.hasTable('customer_accounts')) {
    await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  }
  await knex.raw('DROP FUNCTION IF EXISTS touch_linked_customers_on_account_identity()');
};
