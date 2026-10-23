// Lawn catalog cleanup after the watering-text work (owner 2026-10-23: "aprove
// bpth, cleanup").
//
// 1. LESCO T-Storm 2G Fungicide and Endurant PR Turf Colorant become approved
//    for service reports. A product that is not approved freezes no facts, so
//    its watering rule never reached the visit's instruction and a lawn visit
//    that logged one sent the office an alert in place of a text. Each gets
//    report copy in the wording of the approved products like it, and a
//    watering rule:
//    - T-Storm 2G, label (EPA 228-631; LESCO 228-631-10404): entry waits until
//      "granules and dust have settled"; "For best results,
//      activate the application within 24 hours with irrigation or natural
//      rainfall. If activating by irrigation, apply 0.10-0.25 inch of water."
//    - Endurant PR: Geoponics publishes no directions panel for it (SDS only);
//      the manufacturer says the colorant is rainfast once dry. The rule is the
//      program rule for a spray whose label gives no line: hold until dry.
// 2. Dismiss NXT carried another product's identity: EPA 279-3441 is Gladiator
//    (zeta-cypermethrin + abamectin). Dismiss NXT is EPA 101563-315 (formerly
//    279-3383), sulfentrazone + carfentrazone-ethyl, both HRAC Group 14, so it
//    has no second HRAC group. The "Celsius WG — Application Limits" article
//    called it sulfentrazone + prodiamine; that one line is corrected.
// 3. Moved EPA numbers (PPLS, read 2026-10-22): Prodiamine 65 WDG 66222-89 is
//    now 53883-429 (Control Solutions, 2017-09-15); Nufarm Arena 0.25G
//    66330-70-59639 is now 59639-157 (Valent, Nufarm distributor, 2008-03-07).
//
// Not here: SpeedZone Southern's row mixes the EC actives with the EW EPA
// number (2217-1031); which jug is on the truck decides the fix.
//
// Each catalog item is written only while EVERY field it changes still holds
// the value read from production on 2026-10-23, so a later admin edit to any
// of them leaves the whole item alone (logged). The article line is replaced
// only while it holds the exact old text; its search chunks are purged so
// search re-reads it. One audit_log row per write. Down is a documented no-op
// (waves-db SKILL): the audit rows keep every before value.
const { isDeepStrictEqual } = require('util');
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261023120000_lawn_catalog_report_approvals_and_identity';
const VERIFIED = { verified_at: '2026-10-23T00:00:00.000Z', verified_by: 'label-check-2026-10-22' };
const LOG = '[lawn-catalog-cleanup-20261023]';

const FUNGICIDE_SUMMARY = 'A fungicide that protects turf and plants from fungal disease; it is absorbed into or coats the plant tissue to stop disease organisms from establishing and spreading.';
const DRY_REENTRY = 'Stay off treated areas until the application has dried.';

// { name, set: { column: [before, after] } }
const ITEMS = [
  {
    name: 'LESCO T-Storm 2G Fungicide',
    set: {
      approved_for_service_report: [false, true],
      service_report_summary: [null, FUNGICIDE_SUMMARY],
      // A granule: the label's entry line is about settling, not drying ("Do not enter or allow entry into treated areas
      // until granules and dust have settled").
      customer_precaution_summary: [null, 'Per the product label: keep people and pets off treated areas until the granules and dust have settled.'],
      reentry_summary: [null, 'Stay off treated areas until the granules and dust have settled.'],
      moa_group: [null, 'Group 1'],
      post_application_watering: [null, {
        mode: 'water_in',
        water_in_inches: 0.25,
        water_in_by_hours: 24,
        source: 'label',
        label_note: 'Label: "For best results, activate the application within 24 hours with irrigation or natural rainfall. If activating by irrigation, apply 0.10-0.25 inch of water."',
        ...VERIFIED,
      }],
    },
  },
  {
    name: 'Endurant PR Turf Colorant',
    set: {
      approved_for_service_report: [false, true],
      service_report_summary: [null, 'A turf colorant: a pigment sprayed on the grass blades to give the lawn an even green color. It is not a pesticide or a fertilizer.'],
      customer_precaution_summary: [null, 'Keep people and pets off the treated lawn until the spray has dried; wet colorant can stain shoes, clothing and pavement.'],
      reentry_summary: [null, DRY_REENTRY],
      post_application_watering: [null, {
        mode: 'hold',
        hold_until: 'dry',
        source: 'owner',
        label_note: 'No directions panel published for Endurant PR (Geoponics SDS only); the manufacturer says the colorant is rainfast once dry. Program rule for a spray with no label line: hold until the spray has dried (owner approved 2026-10-23).',
        ...VERIFIED,
      }],
    },
  },
  {
    name: 'Dismiss NXT',
    set: {
      epa_reg_number: ['279-3441', '101563-315'],
      active_ingredient: ['Sulfentrazone', 'Sulfentrazone + Carfentrazone-ethyl'],
      hrac_group_secondary: ['2', null],
      label_source_note: [
        'EPA label 279-3441 (FMC). Sedge/kyllinga primary use. SDS owner-provided 2026-07-03.',
        'EPA label 101563-315 (FMC; formerly 279-3383): sulfentrazone + carfentrazone-ethyl, both HRAC Group 14. Label read 2026-10-22 from EPA PPLS. Sedge/kyllinga primary use. SDS owner-provided 2026-07-03.',
      ],
    },
  },
  { name: 'Prodiamine 65 WDG', set: { epa_reg_number: ['66222-89', '53883-429'] } },
  { name: 'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide', set: { epa_reg_number: ['66330-70-59639', '59639-157'] } },
];

const KB_SLUG = 'celsius-wg-application-limits';
const KB_OLD = '- Dismiss NXT (sulfentrazone + prodiamine) — retired:';
const KB_NEW = '- Dismiss NXT (sulfentrazone + carfentrazone-ethyl) — retired:';

function parseJson(value) {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

// A stored value against a before value: jsonb arrives parsed (or as text), the rest as is.
function holds(stored, before) {
  if (before !== null && typeof before === 'object') return isDeepStrictEqual(parseJson(stored), before);
  return stored === before || (stored == null && before == null);
}

const dbValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

async function audit(knex, canAudit, kind, resourceType, resourceId, metadata) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: resourceType,
    resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true,
    trx: knex,
  });
}

async function applyItem(knex, canAudit, item, columns) {
  const fields = Object.keys(item.set).filter((column) => columns.has(column));
  if (fields.length !== Object.keys(item.set).length) return; // an older schema: change nothing
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', ...fields);
  for (const row of rows) {
    const changed = fields.filter((column) => !holds(row[column], item.set[column][0]));
    if (changed.length) {
      console.log(`${LOG} ${item.name}: ${changed.join(', ')} no longer the value read 2026-10-23 (edited?): row left as it is`);
      continue;
    }
    const update = Object.fromEntries(fields.map((column) => [column, dbValue(item.set[column][1])]));
    const where = knex('products_catalog').where({ id: row.id });
    for (const column of fields) {
      const before = item.set[column][0];
      if (before === null) where.whereNull(column);
      else if (typeof before === 'object') where.whereRaw('??::jsonb = ?::jsonb', [column, JSON.stringify(before)]);
      else where.where(column, before);
    }
    const updated = await where.update({ ...update, updated_at: knex.fn.now() });
    if (updated) {
      await audit(knex, canAudit, 'catalog', 'products_catalog', row.id, {
        product: item.name,
        before: Object.fromEntries(fields.map((column) => [column, item.set[column][0]])),
        after: Object.fromEntries(fields.map((column) => [column, item.set[column][1]])),
      });
    }
  }
}

async function fixArticle(knex, canAudit) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string') return;
  if (!article.content.includes(KB_OLD)) {
    if (!article.content.includes(KB_NEW)) console.log(`${LOG} the article's Dismiss NXT line is not the expected text (edited?): article left as it is`);
    return;
  }
  const updated = await knex('knowledge_base').where({ id: article.id, content: article.content }).update({
    content: article.content.replace(KB_OLD, () => KB_NEW),
    last_verified_at: new Date(),
    verified_by: 'migration-lawn-catalog-cleanup-20261023',
  });
  if (!updated) return;
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
  await audit(knex, canAudit, 'kb_dismiss_nxt_actives', 'knowledge_base', article.id, { slug: KB_SLUG, before: KB_OLD, after: KB_NEW });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const columns = new Set(Object.keys(await knex('products_catalog').columnInfo()));
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) {
    const rule = item.set.post_application_watering && item.set.post_application_watering[1];
    if (rule && !validateRule(rule).valid) continue; // never write a rule the validator rejects
    await applyItem(knex, canAudit, item, columns);
  }
  await fixArticle(knex, canAudit);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
exports.KB_OLD = KB_OLD;
exports.KB_NEW = KB_NEW;
