// The catalog row named "Gentrol IGR" is the bottle the owner actually buys and applies:
// Gentrol Complete EC3 (Zoecon item 10578, 16 fl oz). Owner confirmed 2026-10-25: "every
// Gentrol you apply is Gentrol Complete EC3". The row still carried the identity of a
// different product, Gentrol IGR Concentrate (EPA 2724-351, 9% (S)-hydroprene), so visit
// records, reports and visit emails printed the wrong product. This fixes the row's identity.
//
// Source: EPA PPLS 89459-119 (product name "RF2296 LH EC", alternate brand name "Gentrol
// Complete EC3"), stamped label accepted 2026-02-04, read in full 2026-10-25. Active
// ingredients lambda-cyhalothrin 1.5% + (S)-hydroprene 1.5% (IRAC 3A + 7A), signal word
// WARNING, indoor use only, not restricted use. Label rates per gallon of water: maintenance
// 1.3 fl oz (0.015%), clean-out 2.6 fl oz (0.030%), severe 5.2 fl oz (0.06%).
//
// Only this one catalog row changes, and only while it still has name "Gentrol IGR" and
// EPA 2724-351 (an admin edit made first wins, and a re-run is a no-op). category stays 'igr'
// and product_type stays as is: protocol matching and the visit email read the category.
// target_pests changes only from the exact 20260803200000 seed (see setTargetsWhenExactly).
// The one other thing keyed by this row's NAME is services.default_products (a JSON list of
// catalog names, looked up by exact name): the old name there would no longer resolve, so the
// same entry is renamed in the same change, and the old name is added as a product alias
// (see addOldNameAlias) so exact-name lookups of "Gentrol IGR" still find the row.
// service_products (the past visit lines), vendor_pricing, existing aliases, stock and
// movements are NOT touched (the added alias also stays on rollback).

// Production id of the row: f5646e16-cf4a-4a0e-880c-e8ea0a706c19. Matched by name + EPA number
// instead, so a dev or preview database seeded with a different id follows the same rule.
const OLD_NAME = 'Gentrol IGR';
const NEW_NAME = 'Gentrol Complete EC3';
const OLD_EPA = '2724-351';
const NEW_EPA = '89459-119';

const NEW_LABEL_URL = 'https://www3.epa.gov/pesticides/chem_search/ppls/089459-00119-20260204.pdf';
const NEW_SDS_URL = 'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/sds/gentrol-complete-ec3-sds.pdf';
const NEW_VERIFIED_BY = 'owner-confirmed-gentrol-complete-ec3-2026-10-25';

const OLD_LABEL_SOURCE_NOTE = 'Manufacturer label page lists Gentrol IGR Concentrate as EPA Reg. 2724-351 with 9% (S)-hydroprene.'
  + ' | manufacturer: https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf'
  + ' \u2014 "DILUTION PREPARATION FOR SURFACE SPRAY/PAINT BRUSH, SPOT AND CRACK AND CREVICE PREPARATIONS: Use 1 ounce of GENTROL to 1 gallon of diluent.'
  + ' Partially fill the mixing container with diluent, add the GENTROL, shake or stir"';

// The values the row holds before this migration (batch 1 seed 20260528000002 and the
// 20260712100000 label-rate backfill), written back by down().
const OLD = Object.freeze({
  name: OLD_NAME,
  active_ingredient: '(S)-Hydroprene 9.0%',
  moa_group: 'Group 7A',
  formulation: 'concentrate',
  default_rate: '1',
  epa_reg_number: OLD_EPA,
  label_url: 'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf',
  sds_url: 'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/sds/gentrol-igr-concentrate-sds.pdf',
  label_verified_at: '2026-05-28T00:00:00Z',
  label_verified_by: 'inventory-data-completion-batch-1',
  // The exact production value read 2026-10-26: the batch 1 note, then the note the
  // 20260712100000 label-rate backfill appended with " | ".
  label_source_note: OLD_LABEL_SOURCE_NOTE,
  service_report_summary: 'An insect growth regulator: rather than a quick knockdown, it prevents immature insects from developing into breeding adults, breaking the life cycle over the following weeks.',
  customer_precaution_summary: 'Per the product label: keep people and pets off treated areas until sprays have dried.',
  reentry_summary: 'Do not allow people or pets to enter the treated area until sprays have dried.',
});

const NEW = Object.freeze({
  name: NEW_NAME,
  active_ingredient: 'Lambda-cyhalothrin 1.5% + (S)-Hydroprene 1.5%',
  moa_group: 'Group 3A + 7A',
  formulation: 'emulsifiable concentrate',
  default_rate: '1.3',
  epa_reg_number: NEW_EPA,
  label_url: NEW_LABEL_URL,
  sds_url: NEW_SDS_URL,
  label_verified_by: NEW_VERIFIED_BY,
  label_source_note: 'EPA PPLS 89459-119 (RF2296 LH EC, alternate brand Gentrol Complete EC3), stamped label accepted 2026-02-04; Zoecon SDS 04/02/2021. Owner confirmed 2026-10-25 that every Gentrol applied is Gentrol Complete EC3.',
  service_report_summary: 'An indoor insecticide combined with an insect growth regulator: it kills roaches and other listed pests that contact the treatment, and the growth regulator keeps young roaches from becoming adults that can breed, breaking the life cycle.',
  customer_precaution_summary: 'Per the product label: keep people and pets off treated surfaces until they have dried.',
  reentry_summary: 'Do not let people or pets touch treated surfaces until they have dried.',
});

// default_products is a jsonb array of catalog names. Rename one element, keep order.
// The ? in the jsonb operator is avoided on purpose (a raw ? is a knex binding); the
// containment test uses @> with a bound jsonb value.
async function renameDefaultProduct(knex, from, to) {
  if (!(await knex.schema.hasTable('services'))) return 0;
  if (!(await knex.schema.hasColumn('services', 'default_products'))) return 0;
  const result = await knex.raw(
    `UPDATE services
        SET default_products = (
          SELECT COALESCE(jsonb_agg(CASE WHEN e.elem = to_jsonb(?::text) THEN to_jsonb(?::text) ELSE e.elem END ORDER BY e.ord), '[]'::jsonb)
            FROM jsonb_array_elements(services.default_products) WITH ORDINALITY AS e(elem, ord)
        )
      WHERE jsonb_typeof(default_products) = 'array'
        AND default_products @> to_jsonb(ARRAY[?::text])`,
    [from, to, from],
  );
  return result.rowCount || 0;
}

const normalizeAlias = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

// The old name keeps resolving. Two lookups read product_aliases for an exact name:
// resolveCatalogProductForName in services/completion-product-defaults.js (the protocol
// and default-product lists; its token-subset step cannot reach "Gentrol Complete EC3"
// from "Gentrol IGR") and activeProductsForAlias in services/purchase-receipts/product-matcher.js
// (receipt titles and the tech Intelligence Bar lookup). Added only when no alias with
// the same normalized name exists, whatever vendor or product it points at.
async function addOldNameAlias(knex, productId) {
  if (!productId || !(await knex.schema.hasTable('product_aliases'))) return false;
  const existing = await knex('product_aliases').select('alias_name');
  if (existing.some((row) => normalizeAlias(row.alias_name) === normalizeAlias(OLD_NAME))) return false;
  await knex('product_aliases').insert({ product_id: productId, alias_name: OLD_NAME, vendor_id: null });
  return true;
}

// The prefill the completion form copies into a visit's targets (SchedulePage reads
// products_catalog.target_pests). 20260803200000 left this row on both cockroach species;
// the Complete EC3 label lists German cockroaches only ("Cockroaches, German"; American
// cockroaches appear nowhere on it). Written only when the value is exactly that seed, in
// either order (jsonb array equality is order-sensitive), so an admin-customized value stays.
const SEED_TARGETS = ['German cockroaches', 'American cockroaches'];
const EC3_TARGETS = ['German cockroaches'];

async function setTargetsWhenExactly(knex, productId, fromLists, toList) {
  if (!productId || !(await knex.schema.hasColumn('products_catalog', 'target_pests'))) return 0;
  const clause = fromLists.map(() => 'target_pests = ?::jsonb').join(' OR ');
  return knex('products_catalog')
    .where({ id: productId })
    .whereRaw(`(${clause})`, fromLists.map((list) => JSON.stringify(list)))
    .update({ target_pests: JSON.stringify(toList), updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const updated = await knex('products_catalog')
    .where({ name: OLD_NAME, epa_reg_number: OLD_EPA })
    .update({
      ...NEW,
      label_verified_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

  if (!updated) {
    console.log('[20261026070000] Gentrol row not changed: it no longer has the name "Gentrol IGR" with EPA 2724-351 (already corrected, or edited by hand). No-op.');
    return;
  }

  const renamed = await renameDefaultProduct(knex, OLD_NAME, NEW_NAME);
  const row = await knex('products_catalog').where({ name: NEW_NAME, epa_reg_number: NEW_EPA }).first('id');
  const aliased = await addOldNameAlias(knex, row && row.id);
  const retargeted = await setTargetsWhenExactly(
    knex, row && row.id, [SEED_TARGETS, [...SEED_TARGETS].reverse()], EC3_TARGETS,
  );
  console.log(`[20261026070000] Gentrol IGR is now Gentrol Complete EC3 (EPA 89459-119); ${renamed} service library row(s) renamed in default_products; old-name alias ${aliased ? 'added' : 'not added (one already exists)'}; target_pests ${retargeted ? 'set to German cockroaches' : 'left as is'}.`);
};

// Restores every column up() changed, only while the row still holds the new identity.
// The "Gentrol IGR" alias stays: it may predate this migration, and an alias for the old
// name on a row named "Gentrol IGR" is harmless after a rollback.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const current = await knex('products_catalog').where({ name: NEW_NAME, epa_reg_number: NEW_EPA }).first('id');
  // The seed comes back only from exactly the value up() wrote.
  await setTargetsWhenExactly(knex, current && current.id, [EC3_TARGETS], SEED_TARGETS);

  const reverted = await knex('products_catalog')
    .where({ name: NEW_NAME, epa_reg_number: NEW_EPA })
    .update({ ...OLD, updated_at: knex.fn.now() });

  if (!reverted) {
    console.log('[20261026070000] down: the Gentrol row no longer holds the Complete EC3 identity. No-op.');
    return;
  }
  await renameDefaultProduct(knex, NEW_NAME, OLD_NAME);
};

exports.OLD = OLD;
exports.NEW = NEW;
