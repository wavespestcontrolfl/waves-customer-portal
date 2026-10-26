const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20261026180000_antapex_wsg_identity.js');

const MIGRATIONS = path.join(__dirname, '../models/migrations');

// A small in-memory knex stand-in: products_catalog and product_aliases are arrays of rows;
// where / whereNull filter them; update, insert, del, first and select act on the matches.
// Every call is also recorded, and the services rename is a recorded raw statement.
function fakeKnex({ product = true, aliases = [] } = {}) {
  const calls = { where: [], update: [], insert: [], del: [], raw: [], tables: [] };
  const db = {
    products_catalog: product ? [{ id: 'p-1', name: 'Alpine WSG', epa_reg_number: '499-561' }] : [],
    product_aliases: aliases.map((alias, i) => ({ id: `a-${i}`, vendor_id: null, ...alias })),
  };
  const knex = (table) => {
    calls.tables.push(table);
    const rows = db[table];
    let matched = rows.slice();
    const builder = {
      where(cond) { calls.where.push({ table, cond }); matched = matched.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return builder; },
      whereNull(col) { matched = matched.filter((r) => r[col] == null); return builder; },
      select() { return Promise.resolve(matched.map((r) => ({ ...r }))); },
      first() { return Promise.resolve(matched[0] ? { ...matched[0] } : undefined); },
      update(values) { calls.update.push({ table, values }); matched.forEach((r) => Object.assign(r, values)); return Promise.resolve(matched.length); },
      insert(values) { calls.insert.push({ table, values }); rows.push({ id: `new-${rows.length}`, ...values }); return Promise.resolve([1]); },
      del() { calls.del.push({ table, ids: matched.map((r) => r.id) }); db[table] = rows.filter((r) => !matched.includes(r)); return Promise.resolve(matched.length); },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true, hasColumn: async () => true };
  knex.raw = jest.fn(async (sql, bindings) => { calls.raw.push({ sql, bindings }); return { rowCount: 3 }; });
  return { knex, calls, db };
}

describe('20261026180000 Atticus Antapex WSG identity', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  test('the old values it restores are what the seeding migrations wrote', () => {
    const batch1 = fs.readFileSync(path.join(MIGRATIONS, '20260528000002_inventory_product_data_completion_batch1.js'), 'utf8');
    const backfill = fs.readFileSync(path.join(MIGRATIONS, '20260712100000_catalog_label_rate_backfill.js'), 'utf8');
    const enrich = fs.readFileSync(path.join(MIGRATIONS, '20260717000010_enrich_products_catalog_public_page.js'), 'utf8');
    // The live note is the batch 1 note, then the backfill's note appended with " | " (production value read 2026-10-26).
    const [batchNote, backfillNote] = migration.OLD.label_source_note.split(' | epa_ppls: ');
    expect(batch1).toContain(batchNote);
    // The backfill source holds the second note JSON-escaped inside a JS string.
    const wanted = JSON.stringify(`epa_ppls: ${backfillNote}`.split(' | NOTE: ')[0]).slice(1, -1);
    expect(backfill).toContain(wanted);
    expect(backfill).toContain(JSON.stringify(backfillNote.split(' | NOTE: ')[1]).slice(1, -1));
    expect(batch1).toContain("epa_reg_number: '499-561'");
    expect(enrich).toContain(migration.OLD.label_url);
    expect(enrich).toContain(migration.OLD.sds_url);
    expect(migration.OLD.label_verified_by).toBe('inventory-data-completion-batch-1');
  });

  test('up changes only the row that still reads Alpine WSG with EPA 499-561', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.where[0]).toEqual({ table: 'products_catalog', cond: { name: 'Alpine WSG', epa_reg_number: '499-561' } });
    const catalogUpdates = calls.update.filter((u) => u.table === 'products_catalog');
    expect(catalogUpdates).toHaveLength(1);
    expect(catalogUpdates[0].values).toMatchObject({
      name: 'Atticus Antapex WSG',
      epa_reg_number: '91234-401',
      label_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/091234-00401-20251216.pdf',
      sds_url: 'https://atticusllc.com/wp-content/uploads/2025/11/Antapex-WSG_HCS2024-SDS_20260112.pdf',
      label_verified_by: 'owner-confirmed-antapex-wsg-2026-10-26',
    });
    // Everything the Antapex label shares with Alpine's is left alone: the active ingredient, mode of
    // action, formulation, grams-per-gallon rate, signal word, re-entry, the customer sentences, target
    // pests, category and product type (protocol matching and the visit email read the category).
    for (const column of [
      'active_ingredient', 'moa_group', 'formulation', 'default_rate', 'default_unit', 'signal_word', 'rei_hours',
      'category', 'product_type', 'target_pests', 'container_size', 'inventory_on_hand', 'best_price',
      'service_report_summary', 'customer_precaution_summary', 'reentry_summary', 'reentry_text',
    ]) {
      expect(catalogUpdates[0].values).not.toHaveProperty(column);
    }
    expect(calls.raw).toHaveLength(1);
    expect(calls.raw[0].bindings).toEqual(['Alpine WSG', 'Atticus Antapex WSG', 'Alpine WSG']);
  });

  test('up is a no-op when the row was already corrected or edited (no rename, no alias)', async () => {
    const { knex, calls } = fakeKnex({ product: false });
    await migration.up(knex);
    expect(calls.raw).toEqual([]);
    expect(calls.insert).toEqual([]);
  });

  test('up adds the old name as a vendor-less alias of the row, so exact-name lookups still find it', async () => {
    const { knex, calls, db } = fakeKnex();
    await migration.up(knex);
    expect(calls.insert).toEqual([{ table: 'product_aliases', values: { product_id: 'p-1', alias_name: 'Alpine WSG', vendor_id: null } }]);
    // The alias is found by both exact-name lookups: the receipt matcher and the protocol default-product resolver.
    const { activeProductsForAlias } = require('../services/purchase-receipts/product-matcher');
    const aliasRows = db.product_aliases.map((a) => ({ ...a, id: a.product_id }));
    expect(activeProductsForAlias('alpine  WSG', aliasRows).map((r) => r.id)).toEqual(['p-1']);
    const { resolveCatalogProductForName } = require('../services/completion-product-defaults');
    const catalog = [
      { id: 'p-1', name: 'Atticus Antapex WSG', aliases: db.product_aliases.map((a) => a.alias_name) },
      { id: 'p-2', name: 'Alpine Dust', aliases: [] },
    ];
    expect(resolveCatalogProductForName('Alpine WSG', catalog).id).toBe('p-1');
  });

  test('up adds no alias when one with the same normalized name already exists (any vendor, any product)', async () => {
    for (const existing of [
      { product_id: 'p-1', alias_name: 'alpine wsg' },
      { product_id: 'p-9', alias_name: 'ALPINE-WSG', vendor_id: 'v-1' },
    ]) {
      const { knex, calls } = fakeKnex({ aliases: [existing] });
      await migration.up(knex);
      expect(calls.insert).toEqual([]);
    }
  });

  test('down restores every changed column, only while the row holds the new identity', async () => {
    const { knex, calls, db } = fakeKnex();
    Object.assign(db.products_catalog[0], { name: 'Atticus Antapex WSG', epa_reg_number: '91234-401' });
    await migration.down(knex);
    const catalogUpdate = calls.update.find((u) => u.table === 'products_catalog');
    expect(catalogUpdate.values).toMatchObject({
      name: 'Alpine WSG',
      epa_reg_number: '499-561',
      label_url: 'https://www.domyown.com/msds/Alpine_WSG_Label_2020.pdf',
      sds_url: 'https://www.domyown.com/msds/Alpine_WSG_SDS_2025.pdf',
      label_verified_at: '2026-05-28T00:00:00Z',
      label_verified_by: 'inventory-data-completion-batch-1',
      label_source_note: migration.OLD.label_source_note,
    });
    expect(Object.keys(migration.OLD).sort()).toEqual(
      [...Object.keys(migration.NEW), 'label_verified_at'].sort(),
    );
    expect(calls.raw[0].bindings).toEqual(['Atticus Antapex WSG', 'Alpine WSG', 'Atticus Antapex WSG']);
  });

  test('down leaves the alias in place (it may predate the migration, and is harmless on a row named Alpine WSG)', async () => {
    const { knex, calls, db } = fakeKnex({
      aliases: [
        { product_id: 'p-1', alias_name: 'Alpine WSG' },
        { product_id: 'p-1', alias_name: 'ANTAPEX WSG BROAD SPECTURM WATER DISPERSIBLE GRANULE (WDG/WG) INSECTICIDE 500 GM. BOTTLE' },
      ],
    });
    Object.assign(db.products_catalog[0], { name: 'Atticus Antapex WSG', epa_reg_number: '91234-401' });
    await migration.down(knex);
    expect(calls.del).toEqual([]);
    expect(db.product_aliases).toHaveLength(2);
    expect(db.products_catalog[0].name).toBe('Alpine WSG');
  });

  test('down is a no-op (rows and aliases) when the row no longer holds the new identity', async () => {
    const { knex, calls, db } = fakeKnex({ aliases: [{ product_id: 'p-1', alias_name: 'Alpine WSG' }] });
    await migration.down(knex);
    expect(calls.del).toEqual([]);
    expect(calls.raw).toEqual([]);
    expect(db.products_catalog[0]).toMatchObject({ id: 'p-1', name: 'Alpine WSG', epa_reg_number: '499-561' });
    expect(db.product_aliases).toHaveLength(1);
  });

  test('the SQL carries no literal ? (a raw ? is a knex binding) and never touches past visit lines', async () => {
    const source = fs.readFileSync(path.join(MIGRATIONS, '20261026180000_antapex_wsg_identity.js'), 'utf8');
    for (const forbidden of ['service_products', 'vendor_pricing', 'inventory']) {
      expect(source).not.toMatch(new RegExp(`(?:knex\\(|FROM|UPDATE|INTO)\\s*['"\`]?${forbidden}`, 'i'));
    }
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    const sql = calls.raw[0].sql;
    // Three placeholders for three bindings, all followed by a cast, none a jsonb operator.
    expect((sql.match(/\?/g) || [])).toHaveLength(3);
    expect(sql.match(/\?(?!::text)/g)).toBeNull();
  });

  test('the new label note names the registration, the stamped label and the owner confirmation', () => {
    const { NEW } = migration;
    expect(NEW.label_source_note).toContain('91234-401');
    expect(NEW.label_source_note).toContain('Antapex WSG');
    expect(NEW.label_source_note).toContain('2025-12-16');
    expect(NEW.label_source_note).toContain('Owner confirmed 2026-10-26');
    expect(NEW.label_source_note).not.toContain('499-561');
    // The links are the stamped EPA label and the Atticus SDS, not the BASF documents.
    for (const url of [NEW.label_url, NEW.sds_url]) expect(url).not.toMatch(/alpine/i);
  });
});

describe('Atticus Antapex WSG name is the one protocols.json and the service library resolve', () => {
  test('protocols.json names the new catalog row, never the old one', () => {
    const text = fs.readFileSync(path.join(__dirname, '../config/protocols.json'), 'utf8');
    expect(text).not.toContain('"Alpine WSG"');
    expect((text.match(/"Atticus Antapex WSG"/g) || []).length).toBe(7);
  });
});
