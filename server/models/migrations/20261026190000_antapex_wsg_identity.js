// The catalog row named "Alpine WSG" is the bottle the owner actually buys and applies:
// Atticus Antapex WSG (the generic of Alpine WSG; 500 g resealable bottle). Owner ruling
// 2026-10-26: "the generic version now, and get from siteone instead of alpine". The row
// still carried the identity of BASF Alpine WSG (EPA 499-561), so visit records, reports and
// visit emails printed Alpine's name and EPA number for Antapex applications. This fixes the
// row's identity. SiteOne invoice 172020324-001 (2026-10-09) already bought "ANTAPEX WSG ...
// 500 GM. BOTTLE" and matched it to this row through a product alias; the owner's Amazon
// order of August 2026 was "Atticus Antapex WSG Insecticide (500g)".
//
// Source: EPA PPLS 91234-401 (registered product name "A143.09"; the stamped notice, issued
// 2025-12-16, says "The alternate brand name Antapex WSG, has been added to the product
// record."), read in full 2026-10-26. Atticus, LLC; dinotefuran 40.0% (N-methyl-N-[(tetrahydro-
// 3-furanyl)methyl]guanidine); signal word CAUTION; water-soluble granule; finished dilution
// 0.1% to 0.3% = 10 to 30 grams of product per gallon (the same grams-per-gallon rates the
// Alpine row already carries). Atticus safety data sheet HCS 2024, prepared 2026-01-12.
//
// What stays the same on purpose: active_ingredient (Dinotefuran 40.0%), moa_group (4A),
// formulation (WSG), default_rate/default_unit (10-30 g/gal), signal word, re-entry text,
// container size, the report/precaution/re-entry customer sentences (each is true of the
// Antapex label word for word in substance: non-repellent, and "DO NOT allow children or pets
// to contact treated surfaces until spray has dried"), target pests, stock, and vendor pricing.
//
// Only this one catalog row changes, and only while it still has name "Alpine WSG" and EPA
// 499-561 (an admin edit made first wins, and a re-run is a no-op). category stays and
// product_type stays: protocol matching and the visit email read the category.
// The one other thing keyed by this row's NAME is services.default_products (a JSON list of
// catalog names, looked up by exact name): the old name there would no longer resolve, so the
// same entry is renamed in the same change, and the old name is added as a product alias
// (see addOldNameAlias) so exact-name lookups of "Alpine WSG" (and what a tech says) still find
// the row. service_products (the past visit lines, which keep the name and EPA number recorded
// on the day), vendor_pricing, existing aliases, stock and movements are NOT touched; the
// added alias also stays; down() is a no-op, see below.

// Production id of the row: 999bb709-949e-4d52-9e3e-a225643d1331. Matched by name + EPA number
// instead, so a dev or preview database seeded with a different id follows the same rule.
const OLD_NAME = 'Alpine WSG';
const NEW_NAME = 'Atticus Antapex WSG';
const OLD_EPA = '499-561';
const NEW_EPA = '91234-401';

const NEW_LABEL_URL = 'https://www3.epa.gov/pesticides/chem_search/ppls/091234-00401-20251216.pdf';
const NEW_SDS_URL = 'https://atticusllc.com/wp-content/uploads/2025/11/Antapex-WSG_HCS2024-SDS_20260112.pdf';
const NEW_VERIFIED_BY = 'owner-confirmed-antapex-wsg-2026-10-26';

// The exact production value read 2026-10-26: the batch 1 note (20260528000002), then the
// note the 20260712100000 label-rate backfill appended with " | ".
const OLD_LABEL_SOURCE_NOTE = 'EPA label registration 499-561 lists Alpine WSG with dinotefuran 40.0%.'
  + ' | epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000499-00561-20140812.pdf'
  + ' — "Add 10 g to 30 g of product to water per 1,000 ft2 area being treated (1 T = 10 g), then complete the filling of the spray tank.'
  + ' ... One gallon of finished dilution treats 1,000 ft2. ... Exterior Structural and Surroundi"'
  + " | NOTE: EPA-stamped label (accepted 08/12/2014) for product 'TC-315' with Alpine WSG as accepted alternate brand name;"
  + ' Dinotefuran 40.0% confirmed. LABEL RATES ARE IN GRAMS PER GAL';

// The values the row held before this migration (production, read 2026-10-26). Kept for reference and checked by the test; down() does not write them back.
const OLD = Object.freeze({
  name: OLD_NAME,
  epa_reg_number: OLD_EPA,
  label_url: 'https://www.domyown.com/msds/Alpine_WSG_Label_2020.pdf',
  sds_url: 'https://www.domyown.com/msds/Alpine_WSG_SDS_2025.pdf',
  label_verified_at: '2026-05-28T00:00:00Z',
  label_verified_by: 'inventory-data-completion-batch-1',
  label_source_note: OLD_LABEL_SOURCE_NOTE,
});

const NEW = Object.freeze({
  name: NEW_NAME,
  epa_reg_number: NEW_EPA,
  label_url: NEW_LABEL_URL,
  sds_url: NEW_SDS_URL,
  label_verified_by: NEW_VERIFIED_BY,
  label_source_note: 'EPA PPLS 91234-401 (registered as A143.09, alternate brand name Antapex WSG), stamped label issued 2025-12-16; Atticus SDS (HCS 2024) 2026-01-12. Dinotefuran 40.0%, CAUTION, 10 to 30 grams of product per gallon (0.1% to 0.3% finished dilution). Owner confirmed 2026-10-26 that the bottle applied is Atticus Antapex WSG, not BASF Alpine WSG.',
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
// and default-product lists) and activeProductsForAlias in
// services/purchase-receipts/product-matcher.js (receipt titles and the tech Intelligence Bar
// lookup); the tech voice fill also reads the alias, so a tech who still says "Alpine" lands
// on this row. Added only when no alias with the same normalized name exists, whatever
// vendor or product it points at.
async function addOldNameAlias(knex, productId) {
  if (!productId || !(await knex.schema.hasTable('product_aliases'))) return false;
  const existing = await knex('product_aliases').select('alias_name');
  if (existing.some((row) => normalizeAlias(row.alias_name) === normalizeAlias(OLD_NAME))) return false;
  await knex('product_aliases').insert({ product_id: productId, alias_name: OLD_NAME, vendor_id: null });
  return true;
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
    console.log('[20261026190000] Alpine WSG row not changed: it no longer has the name "Alpine WSG" with EPA 499-561 (already corrected, or edited by hand). No-op.');
    return;
  }

  const renamed = await renameDefaultProduct(knex, OLD_NAME, NEW_NAME);
  const row = await knex('products_catalog').where({ name: NEW_NAME, epa_reg_number: NEW_EPA }).first('id');
  const aliased = await addOldNameAlias(knex, row && row.id);
  console.log(`[20261026190000] Alpine WSG is now Atticus Antapex WSG (EPA 91234-401); ${renamed} service library row(s) renamed in default_products; old-name alias ${aliased ? 'added' : 'not added (one already exists)'}.`);
};

// Deliberately a no-op. This is a data correction, not a schema change: down() cannot tell the
// values up() wrote from later administrator edits (a label link or verification note changed
// through the inventory API keeps the same name and EPA number), and it cannot tell a row up()
// renamed from one an administrator had already corrected to the Antapex identity before this
// ran (then up() did nothing). Restoring the hard-coded Alpine values would erase
// administrator-owned data this migration never wrote. Going back to the Alpine name would be a
// new forward migration. The "Alpine WSG" alias and the renamed default_products entries stay.
exports.down = async function down() {
  console.log('[20261026190000] down: no-op. The Antapex identity is a data correction; rolling back would overwrite administrator edits. Rename back with a new forward migration if ever needed.');
};

exports.OLD = OLD;
exports.NEW = NEW;
