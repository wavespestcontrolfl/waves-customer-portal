/**
 * Seed the printed-piece lead_sources rows so a lead from a business card QR,
 * a yard sign or a new-home postcard resolves a lead_source_id (and a funnel
 * channel) instead of reading "Main Site" / website_quote.
 *
 * Printed links already carry UTM tags, but every web path hard-coded the
 * website classification, so those leads were invisible in lead reports. The
 * resolvers (services/print-lead-sources.js, lead-source-evidence.js,
 * lead-source-classify.js, lead-source-resolver.js, routes/lead-webhook.js,
 * mail/home-book.js) now name a print source; this seeds the rows they look up.
 *
 * Rows share channel 'offline' (the value lead-source-evidence.js already reads
 * as an offline source) and are matched by source_type, one per piece, so the
 * office can rename a row without breaking attribution. A fourth row catches
 * utm_medium=print with a utm_source that names no known piece.
 *
 * Insert-if-absent by source_type: never overwrites an office edit (name, cost,
 * active) once a row exists, and down() is a no-op for the same reason (a delete
 * would strand future print leads at lead_source_id NULL). Mirrors
 * 20260928030000_ai_assistant_lead_source.js. No phone number: these rows are
 * matched by tag, not by a tracking line.
 */
const ROWS = [
  {
    name: 'Business card',
    source_type: 'business_card',
    channel: 'offline',
    landing_page_url: 'https://www.wavespestcontrol.com/quote/?utm_source=business_card',
    notes: 'QR code on the Waves business card. Link tag utm_source=business_card (no medium).',
  },
  {
    name: 'Yard sign',
    source_type: 'yard_sign',
    channel: 'offline',
    landing_page_url: 'https://www.wavespestcontrol.com/neighbor/?utm_source=yard_sign&utm_medium=print&utm_campaign=neighbor',
    notes: 'QR code or link on the yard sign. Link tag utm_source=yard_sign, utm_medium=print.',
  },
  {
    name: 'New-home postcard',
    source_type: 'new_home_postcard',
    channel: 'offline',
    landing_page_url: null,
    notes: 'New-home mailer. The personal /h/<token> booking page and a typed-link miss (utm_source=new_home_postcard, utm_medium=print).',
  },
  {
    name: 'Print — other',
    source_type: 'print_other',
    channel: 'offline',
    landing_page_url: null,
    notes: 'Catch-all: a link tagged utm_medium=print whose utm_source names no known piece. Rename or split when a new printed piece ships.',
  },
];

const STAMP = '20261124150000_print_lead_sources';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');

  for (const row of ROWS) {
    const existing = await knex('lead_sources').where({ source_type: row.source_type }).first();
    if (existing) continue;
    const [inserted] = await knex('lead_sources').insert({
      ...row,
      cost_type: 'free',
      monthly_cost: 0,
      is_active: true,
    }).returning(['id', 'name']);
    // A seeded row writes one audit event when an audit table exists (waves-db skill).
    if (hasAudit && inserted && inserted.id) {
      await require('../../services/audit-log').recordAuditEvent({
        actor_type: 'system',
        action: 'lead_sources.seeded',
        resource_type: 'lead_sources',
        resource_id: inserted.id,
        metadata: {
          source_type: row.source_type,
          name: inserted.name || row.name,
          migration: STAMP,
          reason: 'Printed pieces as lead sources (owner request 2026-11-24): business card, yard sign, new-home postcard',
        },
        trx: knex,
        critical: true,
      });
    }
  }
};

// Seed rollback — never destructive (see header).
exports.down = async function down() {};
