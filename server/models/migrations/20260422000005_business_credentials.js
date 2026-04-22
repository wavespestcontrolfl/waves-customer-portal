/**
 * business_credentials — single source of truth for regulatory + trust
 * credentials (FDACS pest license, insurance certs, business licenses).
 *
 * Consumers (current + planned):
 *   - /api/public/credentials      (Astro build-time fetch, cached in client)
 *   - /admin/credentials           (Virginia CRUD)
 *   - Quote / Invoice PDFs         (internal getCredential helper, follow-up)
 *   - SendGrid email footers       (follow-up)
 *   - PWA + admin footers          (follow-up)
 *
 * Enum-ish text columns use CHECK constraints rather than Knex enum types so
 * future values can be added without ALTER TYPE pain on PostgreSQL.
 *
 * Soft delete only — compliance audit trail requires never losing history.
 * `archived_at` marks a credential as removed; the API filters on it.
 *
 * FDACS license number JB351547 seeded as the first row. Lawn-fertilization
 * license is intentionally NOT seeded until Adam confirms whether it's a
 * separate FDACS credential or covered under the pest-control license; the
 * admin UI makes it trivial to add later without a deploy.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('business_credentials', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('slug').notNullable().unique();
    t.text('display_name').notNullable();
    t.text('credential_type').notNullable();
    t.text('issuing_authority');
    t.text('credential_number').notNullable();
    t.text('holder_name');
    t.date('issued_date');
    t.date('expiration_date');
    t.text('status').notNullable().defaultTo('active');
    t.specificType('jurisdictions', 'text[]');
    t.text('display_format_short');
    t.text('display_format_long');
    t.text('display_format_legal');
    t.boolean('is_public').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(100);
    t.text('notes');
    t.timestamp('archived_at');
    t.timestamps(true, true);
  });

  await knex.raw(
    "ALTER TABLE business_credentials ADD CONSTRAINT business_credentials_type_check " +
    "CHECK (credential_type IN ('license','insurance','certification','registration'))"
  );
  await knex.raw(
    "ALTER TABLE business_credentials ADD CONSTRAINT business_credentials_status_check " +
    "CHECK (status IN ('active','expired','pending_renewal','revoked'))"
  );

  await knex.raw('CREATE INDEX idx_business_credentials_slug ON business_credentials (slug)');
  await knex.raw(
    'CREATE INDEX idx_business_credentials_public_sort ' +
    'ON business_credentials (is_public, status, sort_order) WHERE archived_at IS NULL'
  );

  // ── Seed: FDACS pest control license JB351547 ────────────────────────
  // display_format_legal is a reasonable first-draft rather than verbatim
  // FDACS-required language; Virginia can refine in the admin UI once we
  // confirm against the compliance binder. Kept here so the Astro build +
  // PDF generators don't fall back to an empty string on day one.
  await knex('business_credentials').insert({
    slug: 'fdacs_pest_control',
    display_name: 'FDACS Pest Control Operator License',
    credential_type: 'license',
    issuing_authority: 'Florida Department of Agriculture and Consumer Services',
    credential_number: 'JB351547',
    holder_name: 'Waves Pest Control, LLC',
    status: 'active',
    jurisdictions: ['FL'],
    display_format_short: 'License #JB351547',
    display_format_long: 'FDACS Pest Control License #JB351547',
    display_format_legal:
      'Licensed and regulated by the Florida Department of Agriculture and ' +
      'Consumer Services, License #JB351547',
    is_public: true,
    sort_order: 1,
    notes: 'Primary operator license. Verify display_format_legal against ' +
      'FDACS Ch. 482 signage rule before relying on it for invoices / PDFs.',
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('business_credentials');
};
