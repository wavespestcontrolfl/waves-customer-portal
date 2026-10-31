// Watering rules and report approval for five lawn products added to the catalog on 2026-10-28 by the garage count
// (owner 2026-10-28, "do one final audit, make sure every product has it").
//
// The final audit (20261028210000) re-ran after its deploy and found rows added that evening with no watering rule and
// no report approval. A lawn visit that logs one gets no watering text and an office alert. Five are lawn products, all
// on hand; their labels were read 2026-10-28 and each rule's label_note quotes the line it rests on:
//   - The Andersons 17-0-3 with GrubOut Plus (EPA 228-610-9198): every turf use says water in "immediately", no amount
//     (dung beetle grubs 1/4 to 1/2 inch). Owner: 0.25 inch the same day, as Dylox 6.2 G. The bags on hand carry the
//     2024 label, which names residential lawns; the registration's 2026-02-19 label limits turf use to commercial lawns
//     (old labeling may be sold to 2027-02-19).
//   - LESCO Spar-TECH Micro Mix: label "Avoid watering for 24 hours after application for optimal results." (the stored
//     LESCO Chelated Iron Plus shape).
//   - LESCO Spar-TECH 13-0-0: its label has no watering line; SiteOne's product page says "Avoid irrigation for 24 hours
//     after application to maximize foliar uptake". Owner: the same 24-hour hold as its sister Micro Mix.
//   - Thuricide BT Caterpillar Control (EPA 70051-106-829): the label lists fruits, vegetables, shade trees and
//     ornamentals, no turf: no lawn watering change (as the Arborjet trunk injections).
//   - Blue Planet Nutrients Liquid Seaweed: no watering line; a liquid supplement needs no watering change (as Bloom City
//     Clean Kelp).
// Report copy is the approved sister products' wording, verbatim from the production catalog: Arena 0.25G (systemic
// insecticide) and Dylox 6.2 G (granule watered in the same day) for the GrubOut Plus; LESCO Chelated Iron Plus and K-Flow
// for the Spar-TECH liquids; Conserve SC (reduced-risk insecticide) for the Bt; Bloom City Clean Kelp for the seaweed. Mode-
// of-action groups on the two insecticides: GrubOut Plus imidacloprid (4A) + lambda-cyhalothrin (3A), written "Group 3A +
// 4A" as Temprid FX; Thuricide Bt kurstaki, "Group 11A".
//
// Left out: the other rows that evening are not lawn products (fuel, a carpet cleaner, a mosquito station, a bait
// station, a rodenticide) or are not registered pesticides (a neem oil with no EPA number; a peppermint oil sold with an
// aromatherapy label), and report facts need a valid EPA number for any insecticide.
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only while
// it is false), so any admin edit stands. validateRule runs before a rule is written. One audit_log row per write, with
// before and after. Down is a documented no-op (waves-db SKILL); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261029030000_lawn_new_products_rules_and_approvals';
const LOG = '[lawn-new-products-20261029]';
const VERIFIED = { verified_at: '2026-10-28T00:00:00.000Z', verified_by: 'label-check-2026-10-28' };

// Approved wording, verbatim from the production catalog 2026-10-28.
const SYSTEMIC_INSECTICIDE_SUMMARY = 'A systemic insecticide taken up by the plant and moved through its tissue, so sap-feeding and soil pests take it in as they feed — including pests concealed where sprays cannot reach. Protection builds over days and keeps working for weeks.';
const REDUCED_RISK_SUMMARY = 'A reduced-risk insecticide derived from or modeled on natural compounds; it stops target insects from feeding shortly after exposure while being gentler on beneficial insects when applied per label.';
const MICRONUTRIENT_SUMMARY = 'A micronutrient application supporting leaf color and healthy new growth.';
const LIQUID_FERTILIZER_SUMMARY = 'A professional-grade liquid fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const KELP_SUMMARY = 'A seaweed (kelp) extract: a natural plant supplement that supports strong, vigorous growth. It is not a pesticide.';
const SAME_DAY_GRANULE_PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Water in the same day with about ¼ inch. Keep people and pets off treated areas until it has been watered in and the turf is dry.';
const LIQUID_PRECAUTION = 'Applied in liquid form to the treated areas. If any reaches walks or driveways, it rinses off with water. Watering-in follows the visit notes — treated areas are ready once dry, and your technician confirms timing.';
const SPRAY_PRECAUTION = 'Per the product label: keep people and pets off treated areas until sprays have dried.';
const WATERED_IN_REENTRY = 'Stay off treated areas until the product has been watered in and the turf is dry.';
const WATER_IN_REENTRY = 'Water in per the visit notes; no re-entry wait once dry.';
const DRY_REENTRY = 'Stay off treated areas until the application has dried.';

const fields = (rule, summary, precaution, reentry, moa) => ({
  post_application_watering: { when: 'null', value: rule },
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: summary },
  customer_precaution_summary: { when: 'null', value: precaution },
  reentry_summary: { when: 'null', value: reentry },
  ...(moa ? { moa_group: { when: 'null', value: moa } } : {}),
});

// { name, fields: { column: { when, value } } }. 'null' = write while the column is NULL; 'false' = write while it is false.
const ITEMS = [
  {
    name: 'The Andersons 17-0-3 Fertilizer with Grubout Plus',
    fields: fields({
        mode: 'water_in',
        water_in_inches: 0.25,
        water_in_by_hours: 24,
        water_in_same_day: true,
        source: 'owner',
        label_note: 'Label: "Water grass completely immediately following application." (soil insects) and "water the lawn lightly immediately following application." (surface feeders); no amount, except dung beetle grubs (1/4 to 1/2 inch). Owner: 0.25 inch the same day (as Dylox 6.2 G Granular).',
        ...VERIFIED,
      }, SYSTEMIC_INSECTICIDE_SUMMARY, SAME_DAY_GRANULE_PRECAUTION, WATERED_IN_REENTRY, 'Group 3A + 4A'),
  },
  {
    name: 'LESCO Spar-TECH Micro Mix',
    fields: fields({
        mode: 'hold',
        hold_hours: 24,
        label_minimum: {
          hold_until: 'dry',
        },
        label_best_results: true,
        source: 'label',
        label_note: 'Label: "Avoid watering for 24 hours after application for optimal results."',
        ...VERIFIED,
      }, MICRONUTRIENT_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY),
  },
  {
    name: 'LESCO Spar-TECH 13-0-0',
    fields: fields({
        mode: 'hold',
        hold_hours: 24,
        label_minimum: {
          hold_until: 'dry',
        },
        label_best_results: true,
        source: 'owner',
        label_note: 'Label (LESCO #511362, 2024-03-12): no watering line after application. SiteOne product page: "Avoid irrigation for 24 hours after application to maximize foliar uptake (see product label for full directions)." Owner: no watering for 24 hours for best results, as its sister LESCO Spar-TECH Micro Mix ("Avoid watering for 24 hours after application for optimal results.") and LESCO Chelated Iron Plus.',
        ...VERIFIED,
      }, LIQUID_FERTILIZER_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY),
  },
  {
    name: 'Thuricide BT Caterpillar Control',
    fields: fields({
        mode: 'none',
        source: 'owner',
        label_note: 'Not applied to turf (foliar Bt caterpillar spray for fruits, vegetables, shade trees and ornamentals; the label lists no turf): no lawn watering change.',
        ...VERIFIED,
      }, REDUCED_RISK_SUMMARY, SPRAY_PRECAUTION, DRY_REENTRY, 'Group 11A'),
  },
  {
    name: 'Blue Planet Nutrients Liquid Seaweed .3-.2-1',
    fields: fields({
        mode: 'none',
        source: 'owner',
        label_note: 'Label: no watering line after application. Owner: a liquid supplement needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
        ...VERIFIED,
      }, KELP_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY),
  },
];

const dbValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

async function audit(knex, canAudit, row, column, before, after) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${column}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, column, before, after },
    critical: true,
    trx: knex,
  });
}

async function applyItem(knex, canAudit, item) {
  const columns = [];
  for (const column of Object.keys(item.fields)) {
    if (await knex.schema.hasColumn('products_catalog', column)) columns.push(column);
    else console.log(`${LOG} ${item.name}: products_catalog.${column} does not exist: field skipped`);
  }
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', ...columns);
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    for (const column of columns) {
      const { when, value } = item.fields[column];
      const open = when === 'null' ? row[column] == null : row[column] === false;
      if (!open) {
        console.log(`${LOG} ${item.name}: ${column} already set: left as it is`);
        continue;
      }
      if (column === 'post_application_watering' && !validateRule(value).valid) {
        console.log(`${LOG} ${item.name}: rule rejected by validateRule: not written`);
        continue;
      }
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: dbValue(value), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, when === 'null' ? null : false, value);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) await applyItem(knex, canAudit, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
