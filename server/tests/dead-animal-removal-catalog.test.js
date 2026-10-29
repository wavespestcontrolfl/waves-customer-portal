/**
 * Dead Rodent Removal & Odor Treatment, the booking / completion / copy side (owner approved 2026-10-26, dark behind
 * GATE_DEAD_ANIMAL_REMOVAL): the two migrations (catalog row + completion profile + taxability; pricing_config seed), the
 * completion-lane decision, the service-family identity, the on-site minutes that size the booked slot, the customer
 * estimate copy and the admin validator. A saved estimate with the line keeps working with the gate off. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const catalog = require('../models/migrations/20261029130000_dead_rodent_removal_catalog');
const seedMigration = require('../models/migrations/20261029130100_dead_rodent_removal_pricing_config');
const constants = require('../services/pricing-engine/constants');
const config = require('../services/pricing-engine/dead-animal-removal-config');
const { classifyCatalogRow } = require('../config/completion-lane-registry');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { oneTimeCopyKeyFor, resolveOneTimeServiceCopy } = require('../services/estimate-one-time-copy');
const copyPack = require('../services/estimate-one-time-copy.json');
const estimatePublic = require('../routes/estimate-public');
const availability = require('../services/estimate-slot-availability');

const KEY = 'rodent_dead_animal_removal';
const NAME = 'Dead Rodent Removal & Odor Treatment';

let savedGate;
beforeAll(() => { savedGate = process.env.GATE_DEAD_ANIMAL_REMOVAL; process.env.GATE_DEAD_ANIMAL_REMOVAL = 'true'; });
afterAll(() => { if (savedGate === undefined) delete process.env.GATE_DEAD_ANIMAL_REMOVAL; else process.env.GATE_DEAD_ANIMAL_REMOVAL = savedGate; });

// A small in-memory knex: tables are arrays of rows; just the calls the two migrations make.
function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const matches = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.lower) return String(r[f.lower.col] || '').toLowerCase() === String(f.lower.val).toLowerCase();
      if (f.like) return JSON.stringify(r[f.like.col] || '').includes(f.like.needle);
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        const lower = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (lower) { filters.push({ lower: { col: lower[1], val: bindings[0] } }); return q; }
        const like = /(\w+)::text LIKE \?/.exec(sql);
        if (like) { filters.push({ like: { col: like[1], needle: String(bindings[0]).replace(/%/g, '') } }); return q; }
        throw new Error(`fake whereRaw: unsupported sql ${sql}`);
      },
      first: async () => { const hit = rowsNow().find(matches); return hit ? { ...hit } : undefined; },
      pluck: async (col) => rowsNow().filter(matches).map((r) => r[col]),
      select: async () => rowsNow().filter(matches).map((r) => ({ ...r })),
      columnInfo: async () => Object.fromEntries((db.__columns[table] || Object.keys(rowsNow()[0] || {})).map((c) => [c, {}])),
      update: async (patch) => { const hits = rowsNow().filter(matches); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(matches); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        const insertNow = () => { (db[table] = rowsNow()).push(stored); };
        let conflictIgnored = false;
        const p = {
          onConflict: () => ({ ignore: () => { conflictIgnored = true; return p; } }),
          returning: async (col) => {
            if (conflictIgnored && rowsNow().some((r) => r.config_key && r.config_key === stored.config_key)) return [];
            insertNow();
            return [{ [col]: stored[col] }];
          },
          then: (resolve, reject) => Promise.resolve().then(() => {
            if (!(conflictIgnored && rowsNow().some((r) => r.config_key && r.config_key === stored.config_key))) insertNow();
          }).then(resolve, reject),
        };
        return p;
      },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  return knex;
}

const emptyDb = () => ({
  __columns: { services: Object.keys({ ...catalog.SERVICE, ...catalog.CLOSEOUT, id: 1, updated_at: 1 }) },
  services: [], service_completion_profiles: [], service_taxability: [], system_settings: [],
  service_records: [], scheduled_services: [], scheduled_service_addons: [], service_addons: [], service_package_items: [],
  discounts: [], leads: [], estimates: [],
  pricing_config: [], pricing_config_audit: [], pricing_changelog: [],
});
const svc = (db) => db.services.find((r) => r.service_key === KEY);

describe('20261029130000 catalog row, completion profile and taxability', () => {
  test('up() inserts the one-time rodent row with engine key, tier minutes and no public exposure', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    const row = svc(db);
    expect(row).toMatchObject({
      service_key: KEY, name: NAME, category: 'rodent', billing_type: 'one_time', is_active: true, is_archived: false,
      public_quote_selectable: false, booking_enabled: false, is_waveguard: false, base_price: 169,
      default_duration_minutes: 45, min_duration_minutes: 45, max_duration_minutes: 90,
    });
    expect(JSON.parse(row.engine_keys)).toEqual([KEY]);
    expect(row.price_range_min).toBe(119);
    expect(row.price_range_max).toBe(269);
  });

  test('the catalog name is the pricer line name verbatim, and the base price is the easy-reach own-visit price', () => {
    expect(catalog.SERVICE.name).toBe(NAME);
    expect(catalog.SERVICE.base_price).toBe(constants.RODENT.deadAnimalRemoval.reachable.alone);
    expect(catalog.SERVICE.price_range_min).toBe(constants.RODENT.deadAnimalRemoval.reachable.riding);
    expect(catalog.SERVICE.price_range_max).toBe(constants.RODENT.deadAnimalRemoval.attic.alone);
    expect(catalog.SERVICE.default_duration_minutes).toBe(constants.RODENT.deadAnimalRemoval.reachable.durationMin);
    expect(catalog.SERVICE.max_duration_minutes).toBe(constants.RODENT.deadAnimalRemoval.attic.durationMin);
  });

  test('NO pesticide application: closeout mirrors rodent_inspection (no application log, no notice), license mirrors it', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    expect(svc(db)).toMatchObject({
      requires_service_report: true, requires_application_log: false, requires_customer_notice: false, requires_customer_signature: false,
      required_photo_count: 2, closeout_requirements_source: 'dead_animal_no_application_v1',
      requires_license: true, license_category: 'GHP',
    });
    // The source is non-inferred, so service-closeout-requirements reads the columns as written.
    const { normalizeRequirements } = require('../services/service-closeout-requirements');
    expect(normalizeRequirements(svc(db))).toMatchObject({ requiresApplicationLog: false, requiresCustomerNotice: false, requiredPhotoCount: 2, requiresLicense: true, licenseCategory: 'GHP' });
  });

  test('without the explicit columns the name would infer an application log (why the columns are written)', () => {
    const { normalizeRequirements } = require('../services/service-closeout-requirements');
    expect(normalizeRequirements({ id: 'x', name: NAME, category: 'rodent', closeout_requirements_source: 'inferred_v1' }).requiresApplicationLog).toBe(true);
    // rodent_inspection reads no application log from the same inference, which is the posture mirrored.
    expect(normalizeRequirements({ id: 'y', name: 'Rodent Inspection', category: 'rodent', closeout_requirements_source: 'inferred_v1' }).requiresApplicationLog).toBe(false);
  });

  test('the completion profile is the typed rodent_sanitation form, auto_send, and classifies healthy', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    const profile = db.service_completion_profiles.find((r) => r.service_key === KEY);
    expect(profile).toMatchObject({
      completion_mode: 'service_report', project_type: 'rodent_sanitation', delivery_mode: 'auto_send', creates_service_record: true,
      billing_type: 'one_time', category: 'rodent', active: true, followup_policy: 'none',
    });
    expect(profile.notes).toContain(catalog.MARKER);
    expect(classifyCatalogRow({ service_key: KEY, billing_type: 'one_time', completion_mode: profile.completion_mode, project_type: profile.project_type, delivery_mode: profile.delivery_mode, profile_active: true })).toEqual({ lane: 'typed', flags: [] });
  });

  test('the taxability row is pest control: residential not taxed, commercial taxed; the label equals the catalog name', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    expect(db.service_taxability.find((r) => r.service_key === KEY)).toMatchObject({
      service_label: NAME, is_taxable: true, tax_category: 'pest_control', residential_taxable: false,
    });
    expect(svc(db)).toMatchObject({ tax_service_key: 'pest_control', is_taxable: false });
  });

  test('up() is idempotent and leaves a pre-existing row untouched', async () => {
    const db = emptyDb();
    db.services.push({ id: 'existing', service_key: KEY, name: 'Edited name', is_active: true });
    await catalog.up(fakeKnex(db));
    await catalog.up(fakeKnex(db));
    expect(db.services).toHaveLength(1);
    expect(svc(db).name).toBe('Edited name');
    const again = emptyDb();
    await catalog.up(fakeKnex(again));
    await catalog.up(fakeKnex(again));
    expect(again.services).toHaveLength(1);
    expect(again.service_completion_profiles).toHaveLength(1);
    expect(again.service_taxability).toHaveLength(1);
  });

  test('down() removes exactly what up() inserted when nothing references the service', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    await catalog.down(knex);
    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(db.service_taxability).toHaveLength(0);
    expect(db.system_settings).toHaveLength(0);
  });

  test.each([
    ['a scheduled visit by service_id', (db, id) => db.scheduled_services.push({ id: 'v1', service_id: id })],
    ['a scheduled add-on row', (db, id) => db.scheduled_service_addons.push({ id: 'a1', service_id: id })],
    ['a scheduled visit by label', (db) => db.scheduled_services.push({ id: 'v2', service_type: NAME.toUpperCase() })],
    ['a saved estimate that carries the line', (db) => db.estimates.push({ id: 'e1', estimate_data: { result: { oneTime: { items: [{ service: KEY }] } } } })],
    ['a service record', (db, id) => db.service_records.push({ id: 'r1', service_id: id })],
  ])('down() keeps and deactivates the service when %s references it', async (_label, reference) => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    reference(db, svc(db).id);
    await catalog.down(knex);
    expect(svc(db)).toMatchObject({ is_active: false });
    expect(db.service_completion_profiles).toHaveLength(1);
    expect(db.service_taxability).toHaveLength(1);
  });

  test('down() never deletes an operator-edited profile or tax row (marker gone), nor a service it did not insert', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    db.service_completion_profiles[0].notes = 'edited by the office';
    db.service_taxability[0].notes = 'edited by the office';
    await catalog.down(knex);
    expect(db.service_completion_profiles).toHaveLength(1);
    expect(db.service_taxability).toHaveLength(1);

    const preexisting = emptyDb();
    preexisting.services.push({ id: 'existing', service_key: KEY, name: NAME, is_active: true });
    const k2 = fakeKnex(preexisting);
    await catalog.up(k2);
    await catalog.down(k2);
    expect(preexisting.services).toHaveLength(1);
  });

  test('a missing optional table is skipped, never an error', async () => {
    const db = emptyDb();
    await expect(catalog.up(fakeKnex(db, { missingTables: ['service_taxability', 'service_completion_profiles'] }))).resolves.toBeUndefined();
    expect(svc(db)).toBeTruthy();
    expect(db.service_taxability).toHaveLength(0);
  });
});

describe('20261029130100 pricing_config seed', () => {
  test('the seed equals the in-code table and passes the one validator', () => {
    expect(seedMigration.SEED).toEqual(config.defaultDeadAnimalRemovalData());
    expect(seedMigration.SEED).toEqual({
      reachable: { alone: constants.RODENT.deadAnimalRemoval.reachable.alone, riding: constants.RODENT.deadAnimalRemoval.reachable.riding, on_site_min: constants.RODENT.deadAnimalRemoval.reachable.durationMin },
      attic: { alone: constants.RODENT.deadAnimalRemoval.attic.alone, riding: constants.RODENT.deadAnimalRemoval.attic.riding, on_site_min: constants.RODENT.deadAnimalRemoval.attic.durationMin },
    });
    expect(config.normalizeDeadAnimalRemovalConfig(seedMigration.SEED)).toMatchObject({ ok: true });
  });

  test('up() inserts the row once, with one audit row and one changelog row; never overwrites an edited row', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await seedMigration.up(knex);
    await seedMigration.up(knex);
    expect(db.pricing_config).toHaveLength(1);
    expect(db.pricing_config[0]).toMatchObject({ config_key: seedMigration.KEY, category: 'rodent' });
    expect(JSON.parse(db.pricing_config[0].data)).toEqual(seedMigration.SEED);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);

    const edited = emptyDb();
    edited.pricing_config.push({ config_key: seedMigration.KEY, data: { reachable: { alone: 159, riding: 109, on_site_min: 45 }, attic: { alone: 229, riding: 179, on_site_min: 90 } } });
    await seedMigration.up(fakeKnex(edited));
    expect(edited.pricing_config[0].data.reachable.alone).toBe(159);
    expect(edited.pricing_config_audit).toHaveLength(0);
  });

  test('down() deletes the row only while it is the seed, and only its own audit records', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await seedMigration.up(knex);
    await seedMigration.down(knex);
    expect(db.pricing_config).toHaveLength(0);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);

    const edited = emptyDb();
    const k2 = fakeKnex(edited);
    await seedMigration.up(k2);
    edited.pricing_config[0].data = JSON.stringify({ ...seedMigration.SEED, reachable: { alone: 159, riding: 109, on_site_min: 45 } });
    await seedMigration.down(k2);
    expect(edited.pricing_config).toHaveLength(1);
    expect(edited.pricing_config_audit).toHaveLength(1);
  });

  test('both migration files exist and the catalog row is created before the price seed', () => {
    const dir = path.join(__dirname, '..', 'models', 'migrations');
    const mine = ['20261029130000_dead_rodent_removal_catalog.js', '20261029130100_dead_rodent_removal_pricing_config.js'];
    for (const file of mine) expect(fs.existsSync(path.join(dir, file))).toBe(true);
    expect(mine[0] < mine[1]).toBe(true);
  });
});

describe('the admin Pricing Logic route', () => {
  const { validatePricingConfigFor } = require('../routes/admin-pricing-config');
  const whole = () => JSON.parse(JSON.stringify(config.defaultDeadAnimalRemovalData()));

  test('the PUT validator accepts the seed and refuses partial, out-of-bounds or foreign rows with the key named', () => {
    expect(validatePricingConfigFor('rodent_dead_animal_removal', whole())).toEqual({ ok: true });
    const partial = { reachable: whole().reachable };
    expect(validatePricingConfigFor('rodent_dead_animal_removal', partial)).toMatchObject({ ok: false });
    expect(validatePricingConfigFor('rodent_dead_animal_removal', partial).error).toMatch(/^rodent_dead_animal_removal: /);
    const slow = whole(); slow.attic.on_site_min = 1000;
    expect(validatePricingConfigFor('rodent_dead_animal_removal', slow).error).toMatch(/on_site_min/);
    const inverted = whole(); inverted.reachable.riding = 500;
    expect(validatePricingConfigFor('rodent_dead_animal_removal', inverted).error).toMatch(/riding may not be more than/);
    expect(validatePricingConfigFor('rodent_dead_animal_removal', { ...whole(), in_wall: { alone: 1, riding: 1, on_site_min: 1 } }).ok).toBe(false);
  });

  test('the route seeds the row with the code defaults and gates its availability with the gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-pricing-config.js'), 'utf8');
    expect(src).toContain("config_key: 'rodent_dead_animal_removal'");
    expect(src).toContain("rodent_dead_animal_removal: 'GATE_DEAD_ANIMAL_REMOVAL'");
    expect(src).toContain("defaultDeadAnimalRemovalData()");
  });
});

describe('the sold line through the stored estimate: identity, copy and the slot', () => {
  const HOME = { homeSqFt: 2000, lotSqFt: 7500, footprint: 1800 };
  // The stored result shape a staff estimate saves: the mapper's output (the priced line rides in oneTime.specItems).
  const storedResult = (tier) => mapV1ToLegacyShape(generateEstimate(translateV2CallToV1Input(HOME, ['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: tier })));
  const profileRows = (tier, id) => availability._internals.oneTimeProfileServices({ id, pricing_authority: null }, { result: storedResult(tier) });

  test('the service-family classifier gives it its own identity, never the bait bucket', () => {
    expect(estimatePublic.serviceFamilyKeyForAdoption({ service: KEY, name: NAME })).toBe(KEY);
    expect(estimatePublic.serviceFamilyKeyForAdoption({ service_type: NAME })).toBe(KEY);
    expect(estimatePublic.oneTimeItemFamilyKeys({ service: KEY, name: NAME })).toEqual([KEY]);
    expect(estimatePublic.serviceFamilyKeyForAdoption({ service_type: 'Rodent Bait Station Service' })).toBe('rodent_bait');
    expect(estimatePublic.serviceCategoryForOneTimeItem({ service: KEY, name: NAME })).toBe('rodent');
  });

  test('slot reservation names it by key', () => {
    const slot = require('../services/slot-reservation');
    expect(slot.cappedServiceType(NAME)).toBe(NAME);
  });

  test('the on-site minutes ride the stored row into the booking profile (45 easy reach, 90 attic)', () => {
    for (const [tier, minutes] of [['reachable', 45], ['attic', 90]]) {
      expect(profileRows(tier, `est-${tier}`).find((s) => s.engineKey === KEY)).toMatchObject({ engineKey: KEY, durationMinutes: minutes });
    }
  });

  test('a custom-quote line books nothing (no profile row)', () => {
    expect(profileRows('in_wall', 'est-2').find((s) => s.engineKey === KEY)).toBeUndefined();
  });

  test('a saved estimate keeps working with the gate OFF: the stored row, the copy and the booking profile never call the pricer', () => {
    const result = storedResult('attic');
    delete process.env.GATE_DEAD_ANIMAL_REMOVAL;
    try {
      const rows = estimatePublic.normalizeOneTimeBreakdown({ result }).items;
      expect(rows.find((i) => i.service === KEY)).toMatchObject({ amount: 269, deadAnimalTier: 'attic', onSiteMinutes: 90 });
      expect(availability._internals.oneTimeProfileServices({ id: 'est-3', pricing_authority: null }, { result }).find((s) => s.engineKey === KEY)).toMatchObject({ durationMinutes: 90 });
      expect(oneTimeCopyKeyFor({ service: KEY, name: NAME, price: 269 })).toBe(KEY);
    } finally {
      process.env.GATE_DEAD_ANIMAL_REMOVAL = 'true';
    }
  });

  test('an estimate whose only container is the raw engine result keeps the tier and its minutes (tier, durationMin)', () => {
    const engineResult = generateEstimate(translateV2CallToV1Input(HOME, ['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: 'attic' }));
    const row = estimatePublic.normalizeOneTimeBreakdown({ engineResult }).items.find((i) => i.service === KEY);
    expect(row).toMatchObject({ amount: 269, deadAnimalTier: 'attic', onSiteMinutes: 90 });
    const profile = availability._internals.oneTimeProfileServices({ id: 'est-raw', pricing_authority: null }, { engineResult });
    expect(profile.find((s) => s.engineKey === KEY)).toMatchObject({ durationMinutes: 90 });
  });

  test('the public breakdown never carries the access tier or the on-site minutes', () => {
    const items = estimatePublic.normalizeOneTimeBreakdown({ result: storedResult('attic') }).items;
    const row = estimatePublic.sanitizePublicOneTimeBreakdown({ items }).items.find((i) => i.service === KEY);
    expect(row).toMatchObject({ amount: 269 });
    expect(row).not.toHaveProperty('deadAnimalTier');
    expect(row).not.toHaveProperty('onSiteMinutes');
  });

  test.each([
    ['attic', 90],
    ['reachable', 60],
  ])('with the scheduling-capacity gate off, a %s removal books at least its on-site minutes (%i)', (tier, minutes) => {
    const prior = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'false';
    try {
      const estimate = { id: `est-slot-${tier}`, pricing_authority: null, estimate_data: JSON.stringify({ result: storedResult(tier) }) };
      expect(availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' }).durationMinutes).toBe(minutes);
    } finally {
      if (prior === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = prior;
    }
  });
});

describe('customer estimate copy', () => {
  const entry = copyPack[KEY];

  test('the pack has the entry in the rodent_sanitation shape and the line resolves to it', () => {
    expect(oneTimeCopyKeyFor({ service: KEY, name: NAME, price: 169 })).toBe(KEY);
    expect(Object.keys(entry).sort()).toEqual(Object.keys(copyPack.rodent_sanitation).sort());
    expect(Object.keys(entry.hero).sort()).toEqual(Object.keys(copyPack.rodent_sanitation.hero).sort());
    expect(entry.includes.length).toBeGreaterThanOrEqual(3);
    expect(entry.hero.h1).toContain('{first}');
  });

  test('a custom-quote line gets no copy (no price, no claims)', () => {
    expect(oneTimeCopyKeyFor({ service: KEY, name: NAME, quoteRequired: true })).toBeNull();
  });

  test('plain wording: no "safe" claim, no product brand, no same-day odor promise', () => {
    const text = JSON.stringify(entry).toLowerCase();
    expect(text).not.toMatch(/\bsafe(ty)?\b|\bnon-?toxic\b|\bharmless\b|\bguarantee/);
    expect(text).not.toMatch(/\b(odoban|zep|nok-?out|febreze|clorox|lysol|bleach|enzyme|ozone)\b/);
    expect(text).not.toMatch(/same[- ]day|immediately|instantly|gone (today|right away)|odor[- ]free|smell[- ]free/);
    expect(text).toMatch(/fades? over the next/);
    expect(text).not.toMatch(/\bhepa\b|epa-registered|disinfect|sanitiz/);
  });

  test('the pack builder returns the entry for the sold row', () => {
    const copy = resolveOneTimeServiceCopy({ service: KEY, name: NAME, price: 169 });
    expect(copy).toMatchObject({ key: KEY, outcome: entry.outcome, terms: entry.terms });
    expect(copy.includes).toEqual(entry.includes);
  });
});

describe('every reader decision is wired', () => {
  test('rain-fit keeps the default: a catalog key not on the rain-OK list keeps a dry hour (owner decides if it joins the list)', () => {
    const rainFit = require('../services/scheduling/rain-fit');
    expect(rainFit.rainClassOf({ name: NAME, serviceKey: KEY })).toBe('outdoor');
  });

  test('visit facts: the key joins the rodent_sanitation line', () => {
    const { VISIT_FACTS_CONTRACT } = require('../config/visit-facts-contract');
    expect(VISIT_FACTS_CONTRACT.rodent_sanitation.catalogKeys).toContain(KEY);
  });

  test('the copy writer binds the key to the sanitation module and the typed sanitation form', () => {
    const prompts = require('../services/service-report/remaining-service-copy-prompts');
    expect(prompts.SERVICE_KEY_BINDINGS[KEY]).toEqual(['rodent_sanitation', 'rodent_sanitation']);
    expect(prompts.resolveRemainingServiceModules({ serviceKey: KEY, findingsType: 'rodent_sanitation' })).toEqual(['rodent_sanitation']);
  });

  test('the job card lists it as a non-chemical rodent service', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'services', 'job-card.js'), 'utf8')).toMatch(/'rodent_inspection', 'rodent_guarantee', 'rodent_dead_animal_removal'/);
  });
});
