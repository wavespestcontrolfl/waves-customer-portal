const priceWorkerRouter = require('../routes/integrations-vendor-price-worker');

const {
  clip,
  isNumericInput,
  toPositiveDecimalOrNull,
  approxEqual,
  priceFingerprintMatches,
  parseReportItem,
  computeChange,
  isUnchangedApprovedPrice,
  classifyAgainstPending,
  resolveDistinctProductId,
  buildSnapshotRow,
  buildPendingVendorPricingRow,
  buildApprovalEventRow,
  SOURCE_TYPE,
} = priceWorkerRouter._test;

describe('Hermes vendor price report helpers', () => {
  describe('parseReportItem', () => {
    test('accepts a valid item with explicit product_id', () => {
      const parsed = parseReportItem(
        { product_id: 'prod-1', price: 128.5, price_type: 'account' },
        'vendor-top',
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.vendorId).toBe('vendor-top'); // fell back to top-level
      expect(parsed.price).toBe(128.5);
      expect(parsed.priceType).toBe('account');
      expect(parsed.availabilityStatus).toBe('unknown'); // default
    });

    test('per-item vendor_id overrides the top-level default', () => {
      const parsed = parseReportItem({ product_id: 'p', price: 1, vendor_id: 'v-item' }, 'v-top');
      expect(parsed.vendorId).toBe('v-item');
    });

    test('defaults price_type to account and availability to unknown', () => {
      const parsed = parseReportItem({ product_id: 'p', price: 5 }, 'v');
      expect(parsed.priceType).toBe('account');
      expect(parsed.availabilityStatus).toBe('unknown');
      expect(parsed.errors).toEqual([]);
    });

    test('rejects a missing/zero/negative price', () => {
      expect(parseReportItem({ product_id: 'p' }, 'v').errors).toContain('price must be a positive number');
      expect(parseReportItem({ product_id: 'p', price: 0 }, 'v').errors).toContain('price must be a positive number');
      expect(parseReportItem({ product_id: 'p', price: -3 }, 'v').errors).toContain('price must be a positive number');
    });

    test('requires a vendor id from somewhere', () => {
      expect(parseReportItem({ product_id: 'p', price: 1 }, null).errors)
        .toContain('vendor_id is required (top-level or per item)');
    });

    test('requires a way to resolve the product', () => {
      expect(parseReportItem({ price: 1 }, 'v').errors)
        .toContain('product_id, vendor_sku, or product_url is required');
    });

    test('accepts vendor_sku or product_url as the product resolver', () => {
      expect(parseReportItem({ vendor_sku: 'SKU1', price: 1 }, 'v').errors).toEqual([]);
      expect(parseReportItem({ product_url: 'https://x/y', price: 1 }, 'v').errors).toEqual([]);
    });

    test('rejects an out-of-enum price_type or availability_status (CHECK-constrained)', () => {
      expect(parseReportItem({ product_id: 'p', price: 1, price_type: 'scraped' }, 'v').errors)
        .toEqual(expect.arrayContaining([expect.stringContaining('price_type must be one of')]));
      expect(parseReportItem({ product_id: 'p', price: 1, availability_status: 'maybe' }, 'v').errors)
        .toEqual(expect.arrayContaining([expect.stringContaining('availability_status must be one of')]));
    });

    test('rejects non-numeric prices that Number() would silently coerce', () => {
      for (const bad of [true, false, [12], { v: 1 }, '12abc', '1e3', 'NaN']) {
        expect(parseReportItem({ product_id: 'p', price: bad }, 'v').errors)
          .toContain('price must be a positive number');
      }
    });

    test('accepts a plain decimal string price', () => {
      const parsed = parseReportItem({ product_id: 'p', price: '128.50' }, 'v');
      expect(parsed.errors).toEqual([]);
      expect(parsed.price).toBe(128.5);
    });

    test('rejects non-USD currency (system is USD-only, no FX)', () => {
      expect(parseReportItem({ product_id: 'p', price: 1, currency: 'EUR' }, 'v').errors)
        .toContain('currency must be USD — multi-currency pricing is not supported');
      // default + case-insensitive USD are accepted
      expect(parseReportItem({ product_id: 'p', price: 1 }, 'v').errors).toEqual([]);
      expect(parseReportItem({ product_id: 'p', price: 1, currency: 'usd' }, 'v').currency).toBe('USD');
    });
  });

  describe('isNumericInput', () => {
    test('accepts finite numbers and plain decimal strings only', () => {
      expect(isNumericInput(12)).toBe(true);
      expect(isNumericInput(-3.5)).toBe(true);
      expect(isNumericInput('128.50')).toBe(true);
      expect(isNumericInput(true)).toBe(false);
      expect(isNumericInput([12])).toBe(false);
      expect(isNumericInput('12abc')).toBe(false);
      expect(isNumericInput(Infinity)).toBe(false);
      expect(isNumericInput(null)).toBe(false);
    });
  });

  describe('toPositiveDecimalOrNull (unit-cost guard)', () => {
    test('keeps positive numbers, drops zero/negative/non-numeric to null', () => {
      expect(toPositiveDecimalOrNull(1.003)).toBe(1.003);
      expect(toPositiveDecimalOrNull('2.5')).toBe(2.5);
      expect(toPositiveDecimalOrNull(0)).toBeNull();
      expect(toPositiveDecimalOrNull(-4)).toBeNull();
      expect(toPositiveDecimalOrNull(null)).toBeNull();
      expect(toPositiveDecimalOrNull(true)).toBeNull();
    });
  });

  describe('row builders drop poisonous unit costs', () => {
    test('a zero/negative landed/normalized unit price is not stored', () => {
      const parsed = {
        productId: 'p', vendorId: 'v', price: 100, priceType: 'account', availabilityStatus: 'unknown',
      };
      const row = buildPendingVendorPricingRow({
        parsed,
        item: { normalized_unit_price: 0, landed_unit_price: -2 },
        mapping: null,
      });
      expect(row.normalized_unit_price).toBeNull();
      expect(row.landed_unit_price).toBeNull();
    });
  });

  describe('classifyAgainstPending (idempotency)', () => {
    test('no existing pending events → insert fresh, nothing to supersede', () => {
      expect(classifyAgainstPending([], 100)).toEqual({
        duplicate: false, duplicateEvent: null, supersedeIds: [],
      });
    });

    test('an identical pending price (within half a cent) is a duplicate', () => {
      const events = [{ id: 'e1', new_price_amount: '100.00' }];
      const verdict = classifyAgainstPending(events, 100.004);
      expect(verdict.duplicate).toBe(true);
      expect(verdict.duplicateEvent.id).toBe('e1');
      expect(verdict.supersedeIds).toEqual([]);
    });

    test('a different pending price supersedes our own stale Hermes events', () => {
      const events = [
        { id: 'e1', new_price_amount: '100.00', source_type: SOURCE_TYPE },
        { id: 'e2', new_price_amount: '90.00', source_type: SOURCE_TYPE },
      ];
      const verdict = classifyAgainstPending(events, 120);
      expect(verdict.duplicate).toBe(false);
      expect(verdict.supersedeIds).toEqual(['e1', 'e2']);
    });

    test('never supersedes a non-Hermes (manual/feed) pending event', () => {
      const events = [
        { id: 'h1', new_price_amount: '100.00', source_type: SOURCE_TYPE },
        { id: 'm1', new_price_amount: '90.00', source_type: 'manual' },
      ];
      const verdict = classifyAgainstPending(events, 120);
      expect(verdict.duplicate).toBe(false);
      expect(verdict.supersedeIds).toEqual(['h1']); // m1 left for the operator
    });

    test('same dollar but changed unit cost is NOT a duplicate (supersedes instead)', () => {
      const events = [{ id: 'e1', new_price_amount: '100.00', landed_unit_price: '1.50', source_type: SOURCE_TYPE }];
      const verdict = classifyAgainstPending(events, 100, { landed_unit_price: 1.99 });
      expect(verdict.duplicate).toBe(false);
      expect(verdict.supersedeIds).toEqual(['e1']);
    });

    test('supersedes a stale Hermes event EVEN WHEN the report duplicates a manual item', () => {
      const events = [
        { id: 'm1', new_price_amount: '120.00', source_type: 'manual' }, // duplicate of the new price
        { id: 'h1', new_price_amount: '100.00', source_type: SOURCE_TYPE }, // stale Hermes
      ];
      const verdict = classifyAgainstPending(events, 120);
      expect(verdict.duplicate).toBe(true);
      expect(verdict.duplicateEvent.id).toBe('m1'); // reuse the manual dup
      expect(verdict.supersedeIds).toEqual(['h1']); // ...but still kill the stale Hermes one
    });

    test('keeps a matching Hermes duplicate but supersedes a different stale Hermes event', () => {
      const events = [
        { id: 'h1', new_price_amount: '120.00', source_type: SOURCE_TYPE }, // matches → reuse
        { id: 'h2', new_price_amount: '100.00', source_type: SOURCE_TYPE }, // stale → supersede
      ];
      const verdict = classifyAgainstPending(events, 120);
      expect(verdict.duplicate).toBe(true);
      expect(verdict.supersedeIds).toEqual(['h2']);
      expect(verdict.supersedeIds).not.toContain('h1');
    });
  });

  describe('clip (legacy column bounds)', () => {
    test('truncates to width; passes short/blank/null through', () => {
      expect(clip('abc', 50)).toBe('abc');
      expect(clip(null, 50)).toBeNull();
      expect(clip('   ', 50)).toBeNull();
      expect(clip('x'.repeat(80), 50)).toHaveLength(50);
    });

    test('buildPendingVendorPricingRow clips an over-long SKU/URL to the legacy widths', () => {
      const parsed = {
        vendorId: 'v', productId: 'p', priceType: 'account', availabilityStatus: 'unknown',
        currency: 'USD', vendorSku: 'S'.repeat(80), productUrl: `https://x.com/p?${'q'.repeat(600)}`,
      };
      const row = buildPendingVendorPricingRow({ parsed, item: {}, mapping: null });
      expect(row.vendor_sku).toHaveLength(50);
      expect(row.vendor_product_url).toHaveLength(500);
    });

    test('buildSnapshotRow clips a long source_url + over-long quantity/branch/uom to column widths', () => {
      const parsed = {
        vendorId: 'v', productId: 'p', price: 10, priceType: 'account',
        availabilityStatus: 'unknown', currency: 'USD', productUrl: `https://x.com/p?${'q'.repeat(900)}`,
      };
      const item = { quantity: 'Q'.repeat(120), branch_name: 'B'.repeat(220), unit: 'U'.repeat(60) };
      const row = buildSnapshotRow({ parsed, item, mapping: null, vendorPricingId: 'vp', change: { changeAmount: null, changePercent: null }, oldPrice: null });
      expect(row.source_url).toHaveLength(700);  // price_snapshots.source_url varchar(700)
      expect(row.quantity).toHaveLength(50);     // narrowest across tables
      expect(row.branch_name).toHaveLength(160);
      expect(row.uom).toHaveLength(30);
    });
  });

  describe('approxEqual', () => {
    test('cent tolerance and null semantics', () => {
      expect(approxEqual(100, 100.004)).toBe(true);
      expect(approxEqual(100, 100.01)).toBe(false);
      expect(approxEqual(null, null)).toBe(true);
      expect(approxEqual(null, 5)).toBe(false);
      expect(approxEqual('2.5', 2.5)).toBe(true);
    });
  });

  describe('priceFingerprintMatches (price + unit costs)', () => {
    const row = { price_amount: '100.00', landed_unit_price: '1.50', normalized_unit_price: '1.20' };

    test('matches on price alone when the report carries no unit costs', () => {
      expect(priceFingerprintMatches(row, 100, {})).toBe(true);
      expect(priceFingerprintMatches(row, 100, { landed_unit_price: null, normalized_unit_price: null })).toBe(true);
    });

    test('a changed landed/normalized unit cost is NOT a match (material change)', () => {
      expect(priceFingerprintMatches(row, 100, { landed_unit_price: 1.99 })).toBe(false);
      expect(priceFingerprintMatches(row, 100, { normalized_unit_price: 1.99 })).toBe(false);
    });

    test('matching unit costs are a match', () => {
      expect(priceFingerprintMatches(row, 100, { landed_unit_price: 1.5, normalized_unit_price: 1.2 })).toBe(true);
    });
  });

  describe('isUnchangedApprovedPrice (recurring-scan no-op)', () => {
    const live = { is_active: true, approval_status: 'approved', price_amount: '100.00' };

    test('true when the live approved price matches within a cent', () => {
      expect(isUnchangedApprovedPrice(live, 100)).toBe(true);
      expect(isUnchangedApprovedPrice(live, 100.004)).toBe(true);
    });

    test('false when the price differs', () => {
      expect(isUnchangedApprovedPrice(live, 101)).toBe(false);
    });

    test('false when the dollar price matches but a reported unit cost changed', () => {
      const liveWithUnit = { ...live, landed_unit_price: '1.50' };
      expect(isUnchangedApprovedPrice(liveWithUnit, 100, { landed_unit_price: 1.99 })).toBe(false);
      expect(isUnchangedApprovedPrice(liveWithUnit, 100, { landed_unit_price: 1.5 })).toBe(true);
    });

    test('false when the existing row is not live-approved', () => {
      expect(isUnchangedApprovedPrice(null, 100)).toBe(false);
      expect(isUnchangedApprovedPrice({ ...live, is_active: false }, 100)).toBe(false);
      expect(isUnchangedApprovedPrice({ ...live, approval_status: 'pending' }, 100)).toBe(false);
    });

    test('falls back to legacy price column when price_amount is absent', () => {
      expect(isUnchangedApprovedPrice({ is_active: true, approval_status: 'auto_approved', price: '50.00' }, 50)).toBe(true);
    });
  });

  describe('resolveDistinctProductId (mapping ambiguity)', () => {
    test('no candidates → unresolved, not ambiguous', () => {
      expect(resolveDistinctProductId([])).toEqual({ productId: null, ambiguous: false, productIds: [] });
    });

    test('one distinct product (even across multiple rows) → resolved', () => {
      const rows = [{ id: 'm1', product_id: 'prod-A' }, { id: 'm2', product_id: 'prod-A' }];
      expect(resolveDistinctProductId(rows)).toEqual({ productId: 'prod-A', ambiguous: false, productIds: ['prod-A'] });
    });

    test('conflicting verified mappings → ambiguous, no auto-resolution', () => {
      const rows = [{ id: 'm1', product_id: 'prod-A' }, { id: 'm2', product_id: 'prod-B' }];
      const r = resolveDistinctProductId(rows);
      expect(r.ambiguous).toBe(true);
      expect(r.productId).toBeNull();
      expect(r.productIds.sort()).toEqual(['prod-A', 'prod-B']);
    });
  });

  describe('computeChange', () => {
    test('returns nulls when there is no prior price', () => {
      expect(computeChange(null, 120)).toEqual({ changeAmount: null, changePercent: null });
    });

    test('computes amount and percent vs the prior price', () => {
      expect(computeChange(100, 120)).toEqual({ changeAmount: 20, changePercent: 20 });
      expect(computeChange(80, 60)).toEqual({ changeAmount: -20, changePercent: -25 });
    });

    test('avoids divide-by-zero when the prior price is 0', () => {
      expect(computeChange(0, 50)).toEqual({ changeAmount: 50, changePercent: null });
    });
  });

  describe('row builders', () => {
    const parsed = {
      productId: 'prod-1',
      vendorId: 'vendor-1',
      price: 128.5,
      priceType: 'account',
      availabilityStatus: 'in_stock',
      vendorSku: 'SKU-9',
      productUrl: 'https://vendor/p/9',
    };
    const item = { unit: 'oz', currency: 'USD', raw_price_text: '$128.50', normalized_unit_price: 1.003 };
    const change = { changeAmount: 8.5, changePercent: 7.08 };

    test('snapshot row carries the price twice, the source tag, and is flagged for review', () => {
      const row = buildSnapshotRow({ parsed, item, mapping: { id: 'map-1' }, vendorPricingId: 'vp-1', change, oldPrice: 120 });
      expect(row.price).toBe(128.5);
      expect(row.price_amount).toBe(128.5);
      expect(row.source_type).toBe(SOURCE_TYPE);
      expect(row.price_type).toBe('account');
      expect(row.requires_approval).toBe(true);
      expect(row.vendor_pricing_id).toBe('vp-1');
      expect(row.distributor_product_map_id).toBe('map-1');
      expect(row.previous_price_amount).toBe(120);
      expect(row.change_amount).toBe(8.5);
      expect(row.uom).toBe('oz');
      // jsonb column written as a JSON string per repo convention
      expect(typeof row.raw_payload_json).toBe('string');
      expect(JSON.parse(row.raw_payload_json).source).toBe(SOURCE_TYPE);
    });

    test('pending vendor_pricing row is inactive + pending, with NO price until approval', () => {
      const row = buildPendingVendorPricingRow({ parsed, item, mapping: null });
      expect(row.approval_status).toBe('pending');
      expect(row.is_active).toBe(false);
      expect(row.source_type).toBe(SOURCE_TYPE);
      // price / price_amount are deliberately unset so the legacy recalcBestPrice
      // (whereNotNull('price')) can't promote an unapproved scraped price.
      expect(row.price).toBeUndefined();
      expect(row.price_amount).toBeUndefined();
      expect(row.vendor_sku).toBe('SKU-9');
      expect(row.unit).toBe('oz');
    });

    test('approval event row is pending and carries old/new/delta', () => {
      const row = buildApprovalEventRow({ parsed, snapshotId: 'snap-1', vendorPricingId: 'vp-1', change, oldPrice: 120 });
      expect(row.snapshot_id).toBe('snap-1');
      expect(row.vendor_pricing_id).toBe('vp-1');
      expect(row.product_id).toBe('prod-1');
      expect(row.vendor_id).toBe('vendor-1');
      expect(row.old_price_amount).toBe(120);
      expect(row.new_price_amount).toBe(128.5);
      expect(row.change_amount).toBe(8.5);
      expect(row.approval_status).toBe('pending');
    });
  });
});
