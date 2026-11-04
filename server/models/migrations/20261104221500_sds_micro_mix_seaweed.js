// Safety data sheet links for LESCO Spar-TECH Micro Mix and Blue Planet Nutrients Liquid Seaweed (owner 2026-10-29,
// "do all these" about "Missing safety data sheets: none exist to link").
//
// Neither sheet was online: siteone.com links only the LESCO granular fertilizer SDS for the Micro Mix item (wrong for
// a liquid), and Blue Planet posts none. Waves asked both on 2026-10-29; each replied with its sheet on 2026-11-02.
// The two PDFs ship in client/public/labels/ and the portal serves them under /labels/:
//   - LESCO Spar-TECH Micro Mix (SiteOne item #511403): SiteOne's own SDS, product name "Spar-Tech Turf & Ornamental
//     Micro Mix", LESCO Spar-TECH logo, prepared 02/09/22. SiteOne sent it for that item number.
//   - Blue Planet Nutrients Liquid Seaweed .3-.2-1: the maker's SDS, product name "Liquid Seaweed", supplier Blue
//     Planet Nutrients, version 2, issued 8/12/2019.
// sds_url prints on customer PDFs (pdf/service-details-pdf.js, pdf/product-list-pdf.js), so the link is absolute.
//
// Fill-if-NULL only: an SDS link an admin set stands. One audit_log row per row changed, with the link and the
// sheet's own identification. Down is a documented no-op (waves-db SKILL); the audit rows keep the before value.
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:sds_url` must fit, so the name stays short.
const MIGRATION = '20261104221500_sds_micro_mix_seaweed';
const LOG = '[sds-micro-mix-seaweed]';
const LABELS_BASE = 'https://portal.wavespestcontrol.com/labels/';

const ITEMS = [
  {
    name: 'LESCO Spar-TECH Micro Mix',
    file: 'lesco-spar-tech-micro-mix-511403-sds.pdf',
    sheet: 'SiteOne SDS "Spar-Tech Turf & Ornamental Micro Mix", prepared 02/09/22; sent by SiteOne for item #511403 on 2026-11-02',
  },
  {
    name: 'Blue Planet Nutrients Liquid Seaweed .3-.2-1',
    file: 'blue-planet-liquid-seaweed-sds.pdf',
    sheet: 'Blue Planet Nutrients SDS "Liquid Seaweed", version 2, issued 8/12/2019; sent by the maker on 2026-11-02',
  },
].map((item) => ({ ...item, url: `${LABELS_BASE}${item.file}` }));

async function applyItem(knex, canAudit, item) {
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'sds_url');
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    if (row.sds_url != null) { console.log(`${LOG} ${item.name}: sds_url already set: left as it is`); continue; }
    const updated = await knex('products_catalog').where({ id: row.id }).whereNull('sds_url')
      .update({ sds_url: item.url, updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:sds_url`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, column: 'sds_url', before: null, after: item.url, sheet: item.sheet },
      critical: true,
      trx: knex,
    });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'sds_url'))) {
    console.log(`${LOG} products_catalog.sds_url does not exist: skipped`);
    return;
  }
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) await applyItem(knex, canAudit, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.ITEMS = ITEMS;
