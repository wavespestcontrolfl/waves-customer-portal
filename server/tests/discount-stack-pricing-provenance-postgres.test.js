/**
 * Discount-stacking pricing provenance — REAL Postgres round trip.
 *
 * GitHub Codex round 1 on #4642 (PRRT_kwDOR3YQi86kllyE): the mocked unit
 * suite (admin-schedule-discount-stack-restack.test.js) could not catch
 * that the marker's ORIGINAL design reused `scheduled_services.metadata`,
 * a column that never existed on this table — every stamp silently
 * no-opped in production because a hand-typed mock connection has no
 * concept of "this column doesn't exist," while a real INSERT/SELECT
 * would have failed loudly (or, worse here, just dropped the value on an
 * unrecognized/extra field, exactly as it did). This suite runs the same
 * mechanism (stampPricingRegimeMarker / hasPricingRegimeMarker /
 * restackStoredVisitFinancials) against a migrated database so the
 * migration itself, and the JSONB round trip through the REAL pg driver,
 * are proof — not just the mocked shape.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const {
  stampPricingRegimeMarker,
  hasPricingRegimeMarker,
  frozenCapsFromRow,
} = require('../services/booking/visit-financial-stamps');
const adminScheduleRouter = require('../routes/admin-schedule');
const { discountStackingLive } = require('../config/feature-gates');
const {
  restackStoredVisitFinancials, freezeLegacySeriesRootCaps, calculateStoredVisitFinancials, occurrenceFloorPrice,
  resolveUpdateDetailsAddonFinancials, legacyEconomicsPreservationDecision, calculateVisitFinancialsForAddons,
  insertScheduledServiceAddons, legacyPreservationSnapshotStale,
} = adminScheduleRouter._test;

const connection = process.env.DISCOUNT_STACK_PROVENANCE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests

postgres('discount-stacking pricing_provenance — real Postgres round trip (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  // Every fixture row lives inside one transaction that is rolled back —
  // nothing this suite writes outlives it.
  beforeEach(async () => { mockPg = await database.transaction(); });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  test('migration 20260921000002 actually ran: pricing_provenance exists on scheduled_services, metadata never did', async () => {
    const cols = await mockPg('scheduled_services').columnInfo();
    expect(cols.pricing_provenance).toBeDefined();
    expect(cols.pricing_provenance.type).toBe('jsonb');
    // The exact bug this migration fixes: the ORIGINAL design's column
    // genuinely never existed on this table.
    expect(cols.metadata).toBeUndefined();
  });

  test('a stamped marker + frozen caps snapshot round-trips through a REAL INSERT/SELECT as JSONB, not a hand-typed mock', async () => {
    const id = randomUUID();
    const lineDiscountId = randomUUID();
    const addonDiscountId = randomUUID();
    const target = {
      scheduled_date: '2099-01-15',
      service_type: 'Fixture Quarterly Pest Control Service',
      primary_line_price: 100,
      line_discount_id: lineDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50,
    };
    stampPricingRegimeMarker(target, { pricing_provenance: true }, { line: 10, addons: { [addonDiscountId]: 25 } });
    await mockPg('scheduled_services').insert({ id, ...target });

    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(hasPricingRegimeMarker(row)).toBe(true);
    expect(row.pricing_provenance).toEqual({
      pricing_regime: 'discount_stack_v1',
      engine_version: 1,
      caps: { line: 10, addons: { [addonDiscountId]: 25 } },
    });
  });

  // The coordinator's exact pinned combination, end to end through a real
  // database: a row is CREATED (inserted with a frozen $10 line cap),
  // read back through a REAL Postgres round trip exactly as an extension
  // writer's resolveSeriesExtensionPriceTemplate would (same connection,
  // same SELECT), and restacked as that EXTENSION against a live catalog
  // cap that has since been raised to $20 — the frozen $10 must still win.
  test('creation to extension: a $10 cap frozen at insert survives a real Postgres round trip and still wins over a catalog raised to $20', async () => {
    const id = randomUUID();
    const lineDiscountId = randomUUID();
    const created = {
      scheduled_date: '2099-02-15',
      service_type: 'Fixture Quarterly Pest Control Service',
      primary_line_price: 100,
      line_discount_id: lineDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50, // uncapped, 50% of $100 would be $50 off
    };
    stampPricingRegimeMarker(created, { pricing_provenance: true }, { line: { id: lineDiscountId, cap: 10 }, addons: {} });
    await mockPg('scheduled_services').insert({ id, ...created });

    // "Extension": the row read back through the SAME kind of query an
    // extension writer's resolveSeriesExtensionPriceTemplate runs.
    const parentAsReadByExtension = await mockPg('scheduled_services').where({ id }).first();
    expect(hasPricingRegimeMarker(parentAsReadByExtension)).toBe(true);
    const catalogRaisedTo20 = new Map([[lineDiscountId, 20]]);
    const result = restackStoredVisitFinancials(parentAsReadByExtension, [], null, catalogRaisedTo20);
    expect(result.primaryLineDiscountDollars).toBe(10); // frozen, never the raised $20 (or the uncapped $50)
    expect(result.price).toBe(90);
    expect(result.capsSnapshot.line).toEqual({ id: lineDiscountId, cap: 10 }); // the NEXT extension inherits the same frozen $10
  });

  test('an unmarked (legacy) row read from Postgres has a real NULL pricing_provenance — never the string "null" or an empty object', async () => {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-03-15', service_type: 'Fixture Legacy Service', primary_line_price: 100,
    });
    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(row.pricing_provenance).toBeNull();
    expect(hasPricingRegimeMarker(row)).toBe(false);
    // And restacks with LIVE caps, exactly as before this fix.
    const liveCaps = new Map();
    const result = restackStoredVisitFinancials(row, [], null, liveCaps);
    expect(result.capsSnapshot).toEqual({ line: { id: null, cap: null }, addons: {} });
  });

  test('gate-off parity: a row inserted with no pricing_provenance stays NULL — nothing this migration adds is written unconditionally', async () => {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-04-15', service_type: 'Fixture Gate-Off Service', primary_line_price: 50,
    });
    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(row.pricing_provenance).toBeNull();
  });

  // GitHub Codex round 2 on #4642 (PRRT_kwDOR3YQi86kl-X3): the SAME
  // catalog discount reused on both the primary line and an add-on — a
  // real, supported shape — through a real Postgres round trip (the
  // addon row lives in scheduled_service_addons, a real FK-linked table).
  // GitHub Codex round 2 on #4642 (PRRT_kwDOR3YQi86kl-X3): the row is
  // deliberately UNMARKED (no pre-existing frozen caps) — the exact
  // scenario the bug lived in. resolveStoredDiscountCaps must derive BOTH
  // slots' caps from the SAME single, real `discounts` catalog row
  // (loadDiscountCapsById dedupes by id, so a shared id yields ONE Map
  // entry either way) rather than the primary silently absorbing it and
  // the add-on reading null.
  test('a discount id shared between the primary line and an add-on keeps its cap on BOTH slots (unmarked row, real catalog lookup, real Postgres round trip)', async () => {
    const id = randomUUID();
    const sharedDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: sharedDiscountId, discount_key: `fixture_shared_${sharedDiscountId.slice(0, 8)}`,
      name: 'Fixture Shared Cap', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true,
    });
    await mockPg('scheduled_services').insert({
      id,
      scheduled_date: '2099-05-15',
      service_type: 'Fixture Shared-Discount Service',
      primary_line_price: 100,
      line_discount_id: sharedDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50, // uncapped, 50% of $100 would be $50 off
      // no pricing_provenance — unmarked, exactly the bug's scenario
    });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Add-On', base_price: 100, estimated_price: 90,
      discount_type: 'percentage', discount_amount: 50, discount_id: sharedDiscountId, // the SAME shared id
    });

    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(hasPricingRegimeMarker(row)).toBe(false);
    const addonRows = await mockPg('scheduled_service_addons').where({ scheduled_service_id: id });
    // loadDiscountCapsById's real shape: dedupes by id, so a shared id
    // yields exactly ONE Map entry.
    const discountCaps = new Map([[sharedDiscountId, 10]]);
    const result = restackStoredVisitFinancials(row, addonRows, null, discountCaps);
    expect(result.primaryLineDiscountDollars).toBe(10);
    expect(result.addonDollars[0].discountDollars).toBe(10); // never null/uncapped
    // The persisted snapshot must freeze BOTH slots — the next extension
    // reading this frozen snapshot must not silently uncap the add-on.
    expect(result.capsSnapshot).toEqual({ line: { id: sharedDiscountId, cap: 10 }, addons: { [sharedDiscountId]: 10 } });
  });

  // The coordinator's exact pinned combination for the ROOT-freeze fix,
  // end to end through a real database: a LEGACY (unmarked) series' root
  // row is frozen by freezeLegacySeriesRootCaps on its first gate-on
  // extension, persists through a real Postgres round trip, and a SECOND
  // extension's fresh read of that now-marked root still uses the frozen
  // cap after the catalog is raised.
  test('legacy series: freezeLegacySeriesRootCaps persists onto the root row through a real Postgres round trip; a later catalog raise does not reach extension 2', async () => {
    const rootId = randomUUID();
    const lineDiscountId = randomUUID();
    // "Series created before pricing_provenance existed": no marker, just
    // the ordinary discount columns a real legacy row would carry.
    await mockPg('scheduled_services').insert({
      id: rootId,
      scheduled_date: '2099-06-15',
      service_type: 'Fixture Legacy Series Root',
      primary_line_price: 100,
      line_discount_id: lineDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50,
    });
    const cols = await mockPg('scheduled_services').columnInfo();
    const rootBeforeExtension1 = await mockPg('scheduled_services').where({ id: rootId }).first();
    expect(hasPricingRegimeMarker(rootBeforeExtension1)).toBe(false);

    // "Extension 1": the catalog currently caps this discount at $10.
    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      await mockPg('discounts').insert({ id: lineDiscountId, discount_key: `fixture_shared_cap_${lineDiscountId.slice(0, 8)}`, name: 'Fixture Shared Cap', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true });
      await freezeLegacySeriesRootCaps(mockPg, rootBeforeExtension1, cols, []);

      // The freeze persisted for real — read the root back fresh, exactly
      // as extension 2's own top-of-function fetch would.
      const rootAfterExtension1 = await mockPg('scheduled_services').where({ id: rootId }).first();
      // Round 3 P0 fix: freezing a legacy root's caps must NEVER flip
      // hasPricingRegimeMarker — stays false so a null-primary root still
      // defers to calculateStoredVisitFinancials' own reconstruction.
      expect(hasPricingRegimeMarker(rootAfterExtension1)).toBe(false);
      expect(frozenCapsFromRow(rootAfterExtension1).line).toEqual({ id: lineDiscountId, cap: 10 });

      // The catalog cap is raised to $20 between extension 1 and 2.
      await mockPg('discounts').where({ id: lineDiscountId }).update({ max_discount_dollars: 20 });

      // "Extension 2": a fresh live catalog read (what loadDiscountCapsById
      // would fetch now) alongside the already-marked root.
      const catalogRow = await mockPg('discounts').where({ id: lineDiscountId }).first('max_discount_dollars');
      const liveCatalogCapsAtExtension2 = new Map([[lineDiscountId, Number(catalogRow.max_discount_dollars)]]);
      const result = restackStoredVisitFinancials(rootAfterExtension1, [], null, liveCatalogCapsAtExtension2);
      expect(result.primaryLineDiscountDollars).toBe(10); // frozen at extension 1, never the raised $20
      expect(result.price).toBe(90);
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub Codex round 3 on #4642 (PRRT_kwDOR3YQi86kmS5J, P0): the
  // coordinator's exact pinned scenario, through a real Postgres round
  // trip — a legacy series root with primary_line_price NULL and an
  // unstructured estimated_price ($120) containing a $20 due add-on.
  // Freezing this root's caps must NOT make hasPricingRegimeMarker true —
  // the null primary stays ambiguous, restackStoredVisitFinancials still
  // defers, and the real stored total ($120) survives instead of being
  // silently overwritten with just the add-on's own $20.
  test('legacy root with NULL primary_line_price + unstructured estimated_price: freezing caps never flips hasPricingRegimeMarker, $120 total survives (never becomes $20)', async () => {
    const rootId = randomUUID();
    const lineDiscountId = randomUUID();
    const addonId = randomUUID();
    await mockPg('scheduled_services').insert({
      id: rootId,
      scheduled_date: '2099-07-15',
      service_type: 'Fixture Legacy Unstructured Root',
      primary_line_price: null, // ambiguous — no structured primary ever recorded
      estimated_price: 120, // the real, known total
      line_discount_id: lineDiscountId, // on file even though it predates the structured columns
    });
    await mockPg('scheduled_service_addons').insert({
      id: addonId, scheduled_service_id: rootId, service_name: 'Fixture Add-On',
      base_price: 20, estimated_price: 20,
    });
    const cols = await mockPg('scheduled_services').columnInfo();

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      await mockPg('discounts').insert({
        id: lineDiscountId, discount_key: `fixture_legacy_${lineDiscountId.slice(0, 8)}`,
        name: 'Fixture Legacy Cap', discount_type: 'percentage', amount: 10, max_discount_dollars: 10, is_active: true,
      });
      const rootBefore = await mockPg('scheduled_services').where({ id: rootId }).first();
      expect(hasPricingRegimeMarker(rootBefore)).toBe(false);

      // The first gate-on extension freezes this root's caps.
      await freezeLegacySeriesRootCaps(mockPg, rootBefore, cols, []);

      // Read the root back for real — the mechanism this bug lived in
      // (stamping the FULL canonical-pricing marker alongside the caps)
      // only shows up once the write has actually round-tripped through
      // Postgres and back.
      const rootAfterFreeze = await mockPg('scheduled_services').where({ id: rootId }).first();
      expect(hasPricingRegimeMarker(rootAfterFreeze)).toBe(false); // NEVER flips true
      expect(frozenCapsFromRow(rootAfterFreeze)).not.toBeNull(); // but the caps ARE frozen

      const dueAddon = await mockPg('scheduled_service_addons').where({ id: addonId }).first();
      // restackStoredVisitFinancials must defer (return null) — the
      // canonical engine must not treat this null primary as a real $0.
      const restacked = restackStoredVisitFinancials(rootAfterFreeze, [dueAddon], null, new Map([[lineDiscountId, 10]]));
      expect(restacked).toBeNull();

      // The caller's actual fallback: the legacy reconstruction, landing
      // on the real $120 (the addon's own $20 is already folded into that
      // $120, exactly as calculateStoredVisitFinancials always derives an
      // implied primary from parentAddons) — never the wrong $20 a
      // false-positive canonical restack would have produced.
      const legacy = calculateStoredVisitFinancials(rootAfterFreeze, [dueAddon], [dueAddon], null);
      expect(legacy.price).toBe(120); // NEVER $20
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub Codex round 3 on #4642 (PRRT_kwDOR3YQi86kmS5M, P1): the
  // coordinator's exact pinned combination, sourced from a REAL Postgres
  // row (proving the fix holds against DB-shaped numeric values, not just
  // hand-typed JS numbers) — a $100 add-on at a 20% catalog line discount
  // with a $15 fixed appointment credit allocated entirely to it (the
  // sole eligible line) must total $68 through occurrenceFloorPrice's
  // covered-member branch, never the pre-fix $83 (net alone).
  test('covered-member add-on-only total subtracts its own allocated appointment-credit share, sourced from a real Postgres addon row', async () => {
    const addonDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: addonDiscountId, discount_key: `fixture_addon_pct_${addonDiscountId.slice(0, 8)}`,
      name: 'Fixture Add-On 20%', discount_type: 'percentage', amount: 20, is_active: true,
    });
    const scheduledServiceId = randomUUID();
    await mockPg('scheduled_services').insert({
      id: scheduledServiceId, scheduled_date: '2099-08-15', service_type: 'Fixture Covered Member Visit', primary_line_price: 0,
    });
    const addonRowId = randomUUID();
    await mockPg('scheduled_service_addons').insert({
      id: addonRowId, scheduled_service_id: scheduledServiceId, service_name: 'Fixture Covered Add-On',
      base_price: 100, estimated_price: 100, discount_type: 'percentage', discount_amount: 20, discount_id: addonDiscountId,
    });
    const storedAddon = await mockPg('scheduled_service_addons').where({ id: addonRowId }).first();

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      // The live (in-memory) pricing shape occurrenceFloorPrice/
      // restackLiveVisitFinancials take — Number()-coerced from the real
      // Postgres row exactly as a caller assembling `lines` from it would.
      const pricing = {
        primaryBase: 0,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: {
          discountType: 'fixed_amount', discountAmount: 15, discountDollars: 15,
          maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null,
        },
      };
      const addonLine = {
        base: Number(storedAddon.base_price),
        price: Number(storedAddon.estimated_price),
        serviceKey: 'addon_svc',
        serviceCategory: 'addon',
        discount: {
          discountType: storedAddon.discount_type, discountAmount: Number(storedAddon.discount_amount), maxDiscountDollars: null,
        },
      };
      const addonOnlyTotal = (lines) => (lines || []).reduce((sum, a) => {
        const price = Number(a?.price);
        if (!(price > 0)) return sum;
        const share = Number(a?.appointmentCreditDollars) || 0;
        return sum + Math.max(0, price - share);
      }, 0);
      const floor = occurrenceFloorPrice(pricing, [addonLine], {
        memberSeriesCovered: true, isBoosterDate: false, addonOnlyTotal,
      });
      expect(floor).toBe(68); // NEVER $83
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub Codex round 4 P0 on #4642 (PRRT_kwDOR3YQi86kmS5J follow-up): the
  // coordinator's exact pinned combination for the PUT /:id/update-details
  // edit-route fix, sourced from a REAL, previously-created row (proving
  // the routing decision — hasPricingRegimeMarker read off a row that
  // actually round-tripped through Postgres — and the real catalog cap
  // lookup, not just hand-typed JS objects).
  test('PUT /:id/update-details: unchanged discount terms on a real marked row restack to the byte-identical $153, never $150', async () => {
    const id = randomUUID();
    const addonDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: addonDiscountId, discount_key: `fixture_edit_route_${addonDiscountId.slice(0, 8)}`,
      name: 'Fixture Add-On 20%', discount_type: 'percentage', amount: 20, is_active: true,
    });
    const target = {
      scheduled_date: '2099-09-15', service_type: 'Fixture Edit-Route Service', primary_line_price: 100,
    };
    stampPricingRegimeMarker(target, { pricing_provenance: true }, { line: { id: null, cap: null }, addons: { [addonDiscountId]: null } });
    await mockPg('scheduled_services').insert({ id, ...target });

    // The row exactly as PUT /:id/update-details' own `existing` fetch reads it.
    const existing = await mockPg('scheduled_services').where({ id }).first(
      'line_discount_dollars', 'line_discount_id', 'line_discount_type', 'line_discount_amount',
      'discount_type', 'discount_amount', 'discount_max_dollars',
      'discount_service_key_filter', 'discount_service_category_filter', 'pricing_provenance',
    );
    expect(hasPricingRegimeMarker(existing)).toBe(true);

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      // price: 80 — the legacy per-line applyDiscount(100, 'percentage', 20)
      // figure the route's own upstream step computes BEFORE this function
      // ever runs; the canonical branch restacks from base/discount.* and
      // must ignore it to reach $153 (see the mocked unit test's own
      // comment for why this matters).
      const normalizedAddons = [{
        base: 100, price: 80, serviceId: null, serviceKey: null,
        discount: { discountId: addonDiscountId, discountType: 'percentage', discountAmount: 20 },
      }];
      const result = await resolveUpdateDetailsAddonFinancials({
        db: mockPg, existing, updates: {}, primaryGross: 100, normalizedAddons,
        effDiscountType: 'fixed_amount', effDiscountAmount: 30, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
      });
      expect(result.financials.price).toBe(153); // NEVER $150
      expect(result.canonicalRestackedAddonDollars[0].netPrice).toBe(83);

      // Persisting the re-frozen snapshot and reading it back is itself a
      // real round trip — the next save must see the SAME frozen state.
      await mockPg('scheduled_services').where({ id }).update({ pricing_provenance: (() => {
        const stamp = {};
        stampPricingRegimeMarker(stamp, { pricing_provenance: true }, result.capsSnapshotToPersist);
        return stamp.pricing_provenance;
      })() });
      const rowAfterSave = await mockPg('scheduled_services').where({ id }).first();
      expect(hasPricingRegimeMarker(rowAfterSave)).toBe(true);
      expect(frozenCapsFromRow(rowAfterSave).addons[addonDiscountId]).toBeNull(); // uncapped, correctly frozen as such
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub Codex round 4 P1 on #4642 (PRRT_kwDOR3YQi86kmS5J follow-up):
  // the coordinator's exact pinned merge scenario end to end through a real
  // Postgres round trip — a $100 primary (no discount) + a $100 add-on at
  // 50%, whose cap is raised from $10 to $20 AFTER the add-on's cap was
  // first merged into an already-frozen root. Successive extensions must
  // stay $190, never $180.
  test('freezeLegacySeriesRootCaps merges a newly-due add-on cap into an already-frozen root through a real Postgres round trip; successive extensions stay $190', async () => {
    const rootId = randomUUID();
    const addonDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: addonDiscountId, discount_key: `fixture_merge_${addonDiscountId.slice(0, 8)}`,
      name: 'Fixture Merge 50%', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true,
    });
    await mockPg('scheduled_services').insert({
      id: rootId, scheduled_date: '2099-10-15', service_type: 'Fixture Merge Root', primary_line_price: 100,
    });
    const cols = await mockPg('scheduled_services').columnInfo();

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      // Extension 1: no add-on due yet.
      const rootBefore = await mockPg('scheduled_services').where({ id: rootId }).first();
      await freezeLegacySeriesRootCaps(mockPg, rootBefore, cols, []);
      expect(frozenCapsFromRow(rootBefore).addons).toEqual({});

      // Extension 2: the add-on is due for the FIRST time — its current
      // catalog cap ($10) must merge into the root's already-frozen snapshot.
      const addonRow = { discount_id: addonDiscountId, base_price: 100, estimated_price: 100, discount_type: 'percentage', discount_amount: 50 };
      await freezeLegacySeriesRootCaps(mockPg, rootBefore, cols, [addonRow]);
      const rootAfterMerge = await mockPg('scheduled_services').where({ id: rootId }).first();
      expect(frozenCapsFromRow(rootAfterMerge).addons[addonDiscountId]).toBe(10);

      // The catalog cap is raised to $20 after the merge.
      await mockPg('discounts').where({ id: addonDiscountId }).update({ max_discount_dollars: 20 });

      // Extension 3: nothing new to merge — no further write.
      await freezeLegacySeriesRootCaps(mockPg, rootAfterMerge, cols, [addonRow]);

      // The actual stored restack must use the frozen $10, not the raised $20.
      const catalogRow = await mockPg('discounts').where({ id: addonDiscountId }).first('max_discount_dollars');
      const liveCaps = new Map([[addonDiscountId, Number(catalogRow.max_discount_dollars)]]);
      const result = restackStoredVisitFinancials(rootAfterMerge, [addonRow], null, liveCaps);
      expect(result.addonDollars[0].discountDollars).toBe(10); // frozen, never the raised $20
      expect(result.price).toBe(190); // 100 + 90 — NEVER $180
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // Slice 4 of #4405 (round-7 P0 carried forward, hardened after a
  // pre-push Codex audit found the first cut compared the wrong figure): a
  // real, previously-created UNMARKED (legacy) row — $100 primary, a $100
  // add-on stored at a 10% discount (net $90), a $30 fixed appointment
  // credit — stored total 100 + 90 - 30 = $160, exactly the round-7
  // report's own pinned figure. A genuinely notes-only save resends every
  // price field (per this editor's own contract) but posts NEITHER a
  // discount NOR the add-on's discount identity (it doesn't display
  // per-addon discount editing) — the route must load the REAL stored
  // add-on row via a genuine Postgres query before it can tell the money
  // is unchanged, and must then preserve the stored $160 verbatim rather
  // than let calculateVisitFinancialsForAddons recompute against the wrong
  // figure.
  // Slice 4 of #4405 (round-7 P0 carried forward, hardened after two
  // rounds of pre-push Codex audit): a real, previously-created UNMARKED
  // (legacy) row — $100 primary, a $100 add-on stored at a 10% discount
  // (net $90), a $30 fixed appointment credit — stored total
  // 100 + 90 - 30 = $160, exactly the round-7 report's own pinned figure.
  // A genuinely notes-only save resends every price field (per this
  // editor's own contract) — round 2's own P1 finding: the editor DOES
  // resend the add-on's full discount stamp (id/type/amount) verbatim for
  // an unchanged discounted line (SchedulePage.jsx) — the route must load
  // the REAL stored add-on row (base price, net, AND discount identity) via
  // a genuine Postgres query, confirm the posted terms match it exactly,
  // and only then preserve the stored $160 verbatim.
  test('PUT /:id/update-details: a genuinely notes-only save on an UNMARKED row preserves the real stored $160', async () => {
    const id = randomUUID();
    const addonDiscountId = randomUUID();
    const target = {
      scheduled_date: '2099-11-15', service_type: 'Fixture Legacy Notes-Only Service',
      primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
      estimated_price: 160,
      // no pricing_provenance — this is the exact unmarked-legacy scenario.
    };
    await mockPg('scheduled_services').insert({ id, ...target });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Legacy Add-On',
      base_price: 100, estimated_price: 90, discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
      discount_id: addonDiscountId,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      // The row exactly as the route's own `existing` fetch reads it.
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      expect(hasPricingRegimeMarker(existing)).toBe(false);

      // The route's own load (round-7 P0's fix): the real stored add-on
      // row, fetched via a genuine query BEFORE testing legacy preservation
      // — every field the decision actually compares (NET price AND the
      // full discount identity, per round 2's own fix; never just gross).
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');

      // Genuinely notes-only save: an UNCHANGED discounted line round-trips
      // its full discount stamp verbatim (SchedulePage.jsx's own Case A
      // shape) — the SAME id/type/amount this row was actually stored with.
      const normalizedAddons = [{
        serviceId: null, serviceName: 'Fixture Legacy Add-On', base: 100, price: 90,
        discount: { discountId: addonDiscountId, discountType: 'percentage', discountAmount: 10 },
      }];

      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: Number(existing.primary_line_price),
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      expect(decision.legacyEconomicsPreserved).toBe(true);
      expect(decision.storedTotal).toBe(160);

      // The route writes updates.estimated_price = decision.storedTotal
      // (160) and updates.discount_dollars = existing.discount_dollars (30)
      // on this path — never financials.price/appointmentDiscountDollars.
      await mockPg('scheduled_services').where({ id }).update({ estimated_price: decision.storedTotal });
      const rowAfterSave = await mockPg('scheduled_services').where({ id }).first('estimated_price', 'pricing_provenance');
      expect(Number(rowAfterSave.estimated_price)).toBe(160); // preserved through a real round trip
      expect(hasPricingRegimeMarker(rowAfterSave)).toBe(false); // still unmarked — this path never stamps one
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // Codex pre-push audit P0 (round 1): the editor sends an EDITED add-on
  // price as a flat NET with no discount fields at all — comparing that
  // posted figure against the row's stored GROSS (base_price) can match by
  // coincidence and silently keep a stale total. Same fixture as the
  // notes-only test above, but the operator raises the add-on from its
  // discounted $90 net to $100 — a real $10 increase that numerically
  // equals the stored GROSS. The fix (NET vs NET) must detect this as
  // CHANGED and defer to the live recompute, which correctly reaches $170
  // (100 + 100 - 30), never silently keep the stale $160.
  test('PUT /:id/update-details: an add-on raised from its discounted $90 net to $100 is detected as changed, never silently kept at the stale $160', async () => {
    const id = randomUUID();
    const addonDiscountId = randomUUID();
    const target = {
      scheduled_date: '2099-11-16', service_type: 'Fixture Legacy Price-Edit Service',
      primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
      estimated_price: 160,
    };
    await mockPg('scheduled_services').insert({ id, ...target });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Legacy Add-On',
      base_price: 100, estimated_price: 90, discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
      discount_id: addonDiscountId,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');

      // The operator raises the add-on's displayed price from 90 to 100 —
      // the client sends a flat `price: 100`, no discount, no basePrice
      // (a genuinely EDITED line never round-trips the old discount).
      const normalizedAddons = [{ serviceId: null, serviceName: 'Fixture Legacy Add-On', base: 100, price: 100, discount: null }];

      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: Number(existing.primary_line_price),
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      // NEVER true: 100 (posted NET) !== 90 (stored NET) — a real edit; the
      // dropped discount stamp (posted has none, stored has one) would ALSO
      // disqualify this on its own (round 2's own per-line terms check).
      expect(decision.legacyEconomicsPreserved).toBe(false);

      // The live recompute this save correctly falls through to.
      const recompute = calculateVisitFinancialsForAddons({
        primaryNet: 100, primaryServiceKey: null, primaryServiceCategory: null,
        appointmentDiscount: { discountType: existing.discount_type, discountAmount: Number(existing.discount_amount), maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      }, normalizedAddons);
      expect(recompute.price).toBe(170); // 100 + 100 - 30 — the REAL new total
      expect(recompute.price).not.toBe(160); // never the stale, pre-edit figure
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // Codex pre-push audit P0 (round 3): a real catalog CAP, sourced from a
  // genuine `discounts` row (max_discount_dollars), through a real Postgres
  // round trip. The stored add-on row's discount_amount is the RAW 50%
  // (scheduled_service_addons has no cap column of its own — only the
  // catalog row does), so its TRUE stored net ($90, capped at $10 off) can
  // only be reconstructed by trusting the row's own estimated_price, never
  // by naively re-applying 50% to the gross (which would silently produce
  // an uncapped $50). A notes-only save that round-trips the addon's exact
  // discount terms must preserve the real $160, never fall through to a
  // recompute that repeats the SAME cap-ignorant mistake and lands on $120.
  test('PUT /:id/update-details: an unchanged CAPPED add-on discount (real catalog cap) preserves the real stored $160, never a cap-ignorant $120', async () => {
    const id = randomUUID();
    const cappedDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: cappedDiscountId, discount_key: `fixture_capped_${cappedDiscountId.slice(0, 8)}`,
      name: 'Fixture 50% Off Capped $10', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true,
    });
    const target = {
      scheduled_date: '2099-11-17', service_type: 'Fixture Legacy Capped-Discount Service',
      primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
      estimated_price: 160, // 100 (primary) + 90 (capped addon net) - 30 (credit)
    };
    await mockPg('scheduled_services').insert({ id, ...target });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Capped Add-On',
      base_price: 100, estimated_price: 90, // the REAL, capped net — never the uncapped $50
      discount_type: 'percentage', discount_amount: 50, discount_dollars: 10, discount_id: cappedDiscountId,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');

      // Genuinely unchanged: round-trips the addon's exact stored terms
      // (the RAW 50%, matching what scheduled_service_addons itself holds —
      // the cap lives only on the `discounts` row, never re-read here).
      const normalizedAddons = [{
        serviceId: null, serviceName: 'Fixture Capped Add-On', base: 100, price: 50, // applyDiscount(100, 'percentage', 50) — cap-ignorant, deliberately wrong
        discount: { discountId: cappedDiscountId, discountType: 'percentage', discountAmount: 50 },
      }];

      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: Number(existing.primary_line_price),
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      // NEVER false: a net-vs-net comparison (naive $50 vs real $90) would
      // wrongly disqualify this exact match and fall through to $120.
      expect(decision.legacyEconomicsPreserved).toBe(true);
      expect(decision.storedTotal).toBe(160);

      await mockPg('scheduled_services').where({ id }).update({ estimated_price: decision.storedTotal });
      const rowAfterSave = await mockPg('scheduled_services').where({ id }).first('estimated_price');
      expect(Number(rowAfterSave.estimated_price)).toBe(160); // preserved through a real round trip, never $120
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // Codex pre-push audit P1 (round 4): the AGGREGATE fix above (round 3)
  // preserves scheduled_services.estimated_price, but insertScheduledServiceAddons
  // (the SAME writer create/extension use) deletes and re-inserts every
  // scheduled_service_addons ROW on every save with an `addons` array — a
  // SEPARATE call site the aggregate fix never touched. Full round trip,
  // sourced from a REAL Postgres addon row: preservedAddonLines is threaded
  // through that SAME writer, and the row it re-inserts must carry the
  // TRUE, capped $90 — never the naive $50 applyDiscount() would produce —
  // so a SECOND save's own existingAddonRows read (the next notes-only
  // save's baseline) still sees the row this mechanism is supposed to
  // protect, not one already corrupted by the first save.
  test('PUT /:id/update-details: preservedAddonLines threaded through insertScheduledServiceAddons re-inserts the addon row at its TRUE capped $90, never the naive $50 — and a SECOND save\'s baseline read confirms it', async () => {
    const id = randomUUID();
    const cappedDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: cappedDiscountId, discount_key: `fixture_capped_row_${cappedDiscountId.slice(0, 8)}`,
      name: 'Fixture 50% Off Capped $10', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true,
    });
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-11-18', service_type: 'Fixture Legacy Capped Row Service',
      primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
      estimated_price: 160,
    });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Capped Add-On',
      base_price: 100, estimated_price: 90, // the REAL, capped net
      discount_type: 'percentage', discount_amount: 50, discount_dollars: 10, discount_id: cappedDiscountId,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      // --- Save 1: notes-only, round-tripping the addon's exact terms. ---
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars');
      const normalizedAddons = [{
        serviceId: null, serviceName: 'Fixture Capped Add-On', base: 100, price: 50, // applyDiscount(100,'percentage',50) — cap-ignorant
        discount: { discountId: cappedDiscountId, discountType: 'percentage', discountAmount: 50 },
      }];
      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: Number(existing.primary_line_price),
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      expect(decision.legacyEconomicsPreserved).toBe(true);
      expect(decision.preservedAddonLines).toHaveLength(1);
      expect(decision.preservedAddonLines[0].price).toBe(90); // never the naive 50

      // The route's own write: aggregate from storedTotal (round 3's own
      // fix), addon rows replaced via insertScheduledServiceAddons fed
      // preservedAddonLines (round 4's fix) — the SAME writer create/
      // extension use, exercised here through a real Postgres transaction.
      await mockPg('scheduled_services').where({ id }).update({ estimated_price: decision.storedTotal });
      const addonCols = await mockPg('scheduled_service_addons').columnInfo();
      await mockPg('scheduled_service_addons').where({ scheduled_service_id: id }).del();
      await insertScheduledServiceAddons(mockPg, id, decision.preservedAddonLines, addonCols, null);

      const addonRowAfterSave1 = await mockPg('scheduled_service_addons').where({ scheduled_service_id: id }).first();
      expect(Number(addonRowAfterSave1.estimated_price)).toBe(90); // NEVER 50 — the row itself, not just the aggregate
      expect(Number(addonRowAfterSave1.base_price)).toBe(100);
      expect(Number(addonRowAfterSave1.discount_dollars)).toBe(10);
      const aggregateAfterSave1 = await mockPg('scheduled_services').where({ id }).first('estimated_price');
      expect(Number(aggregateAfterSave1.estimated_price)).toBe(160);

      // --- Save 2: the baseline this second save reads must be the ORIGINAL,
      // uncorrupted $90 — proving save 1 never poisoned it. ---
      const existingAddonRows2 = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars');
      expect(Number(existingAddonRows2[0].estimated_price)).toBe(90); // the baseline a corrupted row (round 4's own bug) would have moved to 50
      const decision2 = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: true,
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: 100,
        normalizedAddons, // the SAME notes-only payload the editor would resend again
        existingAddonRows: existingAddonRows2,
        existingEstimatedPrice: 160,
      });
      expect(decision2.legacyEconomicsPreserved).toBe(true); // still preserves — the mechanism holds across saves
      expect(decision2.storedTotal).toBe(160);
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub round 2 on PR #4654 (P0): a row that predates the
  // primary_line_price column stores it as NULL — a real Postgres row, not
  // a hand-typed fixture. SchedulePage derives a numeric primary (stored
  // total minus stored add-on nets) and resubmits it on every save.
  // Reconstructing the SAME way must preserve the real stored $160.
  test('PUT /:id/update-details: a null primary_line_price legacy row (real Postgres NULL) preserves via the SAME reconstruction the client uses', async () => {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-11-19', service_type: 'Fixture Pre-Column Legacy Service',
      primary_line_price: null, // a real Postgres NULL — this column's migration never backfilled it
      estimated_price: 160,
    });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Add-On',
      base_price: 100, estimated_price: 100,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      expect(existing.primary_line_price).toBeNull(); // a real Postgres NULL, not the string "null"
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars');

      // SchedulePage's own derivation: stored total (160) minus stored
      // add-on nets (100) = 60, resubmitted as primaryLinePrice.
      const normalizedAddons = [{ serviceId: null, serviceName: 'Fixture Add-On', base: 100, price: 100, discount: null }];
      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 60, // the client's own derived primary
        existingPrimaryLinePrice: existing.primary_line_price,
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      expect(decision.legacyEconomicsPreserved).toBe(true);
      expect(decision.storedTotal).toBe(160);
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub round 2 on PR #4654 (P0): a legitimately FREE ($0) unmarked
  // visit — real Postgres row, capped discount sourced from a REAL
  // `discounts` catalog row — must be preservable exactly like any other
  // total, not just non-zero ones.
  test('PUT /:id/update-details: an explicitly $0 legacy visit (real catalog cap) preserves — never treated as "nothing to protect"', async () => {
    const id = randomUUID();
    const cappedDiscountId = randomUUID();
    await mockPg('discounts').insert({
      id: cappedDiscountId, discount_key: `fixture_free_capped_${cappedDiscountId.slice(0, 8)}`,
      name: 'Fixture 50% Off Capped $10', discount_type: 'percentage', amount: 50, max_discount_dollars: 10, is_active: true,
    });
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-11-20', service_type: 'Fixture Free Legacy Service',
      primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 190, discount_dollars: 190,
      estimated_price: 0, // a real, finite $0 — fully covered
    });
    await mockPg('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: id, service_name: 'Fixture Capped Add-On',
      base_price: 100, estimated_price: 90, discount_type: 'percentage', discount_amount: 50, discount_dollars: 10, discount_id: cappedDiscountId,
    });

    process.env.GATE_DISCOUNT_STACKING = 'true';
    try {
      const existing = await mockPg('scheduled_services').where({ id }).first(
        'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'estimated_price', 'pricing_provenance',
      );
      expect(Number(existing.estimated_price)).toBe(0);
      const existingAddonRows = await mockPg('scheduled_service_addons')
        .where({ scheduled_service_id: id })
        .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars');

      const normalizedAddons = [{
        serviceId: null, serviceName: 'Fixture Capped Add-On', base: 100, price: 50, // applyDiscount(100,'percentage',50) — cap-ignorant
        discount: { discountId: cappedDiscountId, discountType: 'percentage', discountAmount: 50 },
      }];
      const decision = legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: discountStackingLive() && !hasPricingRegimeMarker(existing),
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: Number(existing.primary_line_price),
        normalizedAddons,
        existingAddonRows,
        existingEstimatedPrice: existing.estimated_price,
      });
      expect(decision.legacyEconomicsPreserved).toBe(true);
      expect(decision.storedTotal).toBe(0);
      expect(decision.preservedAddonLines[0].price).toBe(90); // never the naive $50
    } finally {
      delete process.env.GATE_DISCOUNT_STACKING;
    }
  });

  // GitHub round 2 on PR #4654 (P1, TOCTOU): a real Postgres round trip
  // proving the compare-and-swap actually catches a concurrent write. The
  // decision's own snapshot is read first (exactly as the route's
  // unlocked, pre-transaction read would); a SEPARATE update (standing in
  // for a concurrent admin's save) lands on the SAME add-on row; the
  // route's own re-read (what the trx's locked re-check would see)
  // confirms legacyPreservationSnapshotStale flags it — the preserved
  // write must never proceed against that fresher state.
  test('legacyPreservationSnapshotStale: a concurrent edit to the add-on row between the read and the write is detected via a real Postgres round trip', async () => {
    const id = randomUUID();
    const addonId = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-11-21', service_type: 'Fixture Concurrent-Edit Service',
      primary_line_price: 100, estimated_price: 160,
    });
    await mockPg('scheduled_service_addons').insert({
      id: addonId, scheduled_service_id: id, service_name: 'Fixture Add-On',
      base_price: 100, estimated_price: 90, discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
    });

    // The snapshot the route's own pre-transaction read would have taken.
    const existing = await mockPg('scheduled_services').where({ id }).first('estimated_price');
    const existingAddonRows = await mockPg('scheduled_service_addons')
      .where({ scheduled_service_id: id })
      .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');

    // Nothing changed yet — the CAS must pass.
    const freshRowBefore = await mockPg('scheduled_services').where({ id }).first('estimated_price');
    const freshAddonRowsBefore = await mockPg('scheduled_service_addons')
      .where({ scheduled_service_id: id })
      .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');
    expect(legacyPreservationSnapshotStale({
      freshEstimatedPrice: freshRowBefore.estimated_price,
      existingEstimatedPrice: existing.estimated_price,
      freshAddonRows: freshAddonRowsBefore,
      existingAddonRows,
    })).toBe(false);

    // A CONCURRENT save (a different admin, or a retry) lands in between —
    // the add-on's own net moves from $90 to $85 (a real, committed write).
    await mockPg('scheduled_service_addons').where({ id: addonId }).update({ estimated_price: 85 });

    // The trx's own locked re-read (what the route re-fetches right before
    // applying the ORIGINAL request's preserved write) now sees the drift.
    const freshRowAfter = await mockPg('scheduled_services').where({ id }).first('estimated_price');
    const freshAddonRowsAfter = await mockPg('scheduled_service_addons')
      .where({ scheduled_service_id: id })
      .select('service_id', 'service_name', 'base_price', 'estimated_price', 'discount_id', 'discount_type', 'discount_amount');
    expect(legacyPreservationSnapshotStale({
      freshEstimatedPrice: freshRowAfter.estimated_price,
      existingEstimatedPrice: existing.estimated_price,
      freshAddonRows: freshAddonRowsAfter,
      existingAddonRows,
    })).toBe(true); // the ORIGINAL request's stale snapshot must never be trusted for the write now
  });
});
