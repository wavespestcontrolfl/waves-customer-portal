const inventoryRouter = require('../routes/admin-inventory');

const { parseAutoMapResponse, buildAutoMapRow, calculateMappingConfidenceCap } = inventoryRouter._test;

describe('price-sync auto-map helpers', () => {
  describe('parseAutoMapResponse', () => {
    test('parses a clean JSON object with a mappings array', () => {
      const out = parseAutoMapResponse('{"mappings":[{"productId":"p1","found":true}]}');
      expect(out).toHaveLength(1);
      expect(out[0].productId).toBe('p1');
    });

    test('strips ```json fences', () => {
      const out = parseAutoMapResponse('```json\n{"mappings":[{"productId":"p2"}]}\n```');
      expect(out[0].productId).toBe('p2');
    });

    test('tolerates preamble text before the JSON object', () => {
      const out = parseAutoMapResponse('Here are the results:\n{"mappings":[{"productId":"p3"}]}');
      expect(out[0].productId).toBe('p3');
    });

    test('returns [] on non-JSON', () => {
      expect(parseAutoMapResponse('no json here')).toEqual([]);
      expect(parseAutoMapResponse('')).toEqual([]);
      expect(parseAutoMapResponse(null)).toEqual([]);
    });

    test('returns [] when mappings is missing or not an array', () => {
      expect(parseAutoMapResponse('{"results":[]}')).toEqual([]);
      expect(parseAutoMapResponse('{"mappings":"nope"}')).toEqual([]);
    });
  });

  describe('buildAutoMapRow', () => {
    const product = { id: 'prod-1', name: 'Termidor SC', epa_reg_number: '7969-210' };
    const base = { vendorId: 'ven-1', vendorName: 'SiteOne', connectionId: 'conn-1' };

    test('does not match when there is no proposal', () => {
      const out = buildAutoMapRow({ product, proposal: undefined, ...base });
      expect(out.matched).toBe(false);
      expect(out.note).toBeTruthy();
    });

    test('does not match when found=false', () => {
      const out = buildAutoMapRow({ product, proposal: { productId: 'prod-1', found: false, notes: 'not carried' }, ...base });
      expect(out.matched).toBe(false);
      expect(out.note).toBe('not carried');
    });

    test('does not match when found=true but no identifier (sku/url) is supplied', () => {
      const out = buildAutoMapRow({ product, proposal: { productId: 'prod-1', found: true, confidence: 0.9 }, ...base });
      expect(out.matched).toBe(false);
    });

    test('matches on a vendor SKU and writes an unverified row with package + notes', () => {
      const proposal = {
        productId: 'prod-1', found: true, vendorSku: 'SO-12345',
        packageSizeValue: 20, packageSizeUnit: 'oz', purchaseUom: 'each',
        price: 89.99, confidence: 0.82, notes: 'exact match',
      };
      const { matched, row } = buildAutoMapRow({ product, proposal, ...base });
      expect(matched).toBe(true);
      expect(row.internal_product_id).toBe('prod-1');
      expect(row.vendor_id).toBe('ven-1');
      expect(row.vendor_connection_id).toBe('conn-1');
      expect(row.vendor_sku).toBe('SO-12345');
      expect(row.mapping_status).toBe('mapped_unverified');
      expect(row.package_size_value).toBe(20);
      expect(row.purchase_uom).toBe('each');
      expect(row.mapping_confidence).toBe(0.82);
      expect(row.epa_registration_number).toBe('7969-210');
      expect(row.notes).toContain('AI auto-map (SiteOne)');
      expect(row.notes).toContain('~$89.99');
      expect(row.notes).toContain('exact match');
    });

    test('matches on a product URL only, and omits the price fragment when absent', () => {
      const proposal = { productId: 'prod-1', found: true, productUrl: 'https://siteone.com/p/termidor', confidence: 0.7 };
      const { matched, row } = buildAutoMapRow({ product, proposal, ...base });
      expect(matched).toBe(true);
      expect(row.product_url).toBe('https://siteone.com/p/termidor');
      expect(row.vendor_sku).toBeNull(); // cleanString(undefined) -> null
      expect(row.notes).not.toContain('~$');
      expect(row.package_size_value).toBe(''); // no packageSizeValue -> '' (import treats as null)
    });

    test('never emits a verified status (human gate preserved)', () => {
      const proposal = { productId: 'prod-1', found: true, vendorSku: 'X', confidence: 1 };
      const { row } = buildAutoMapRow({ product, proposal, ...base });
      expect(row.mapping_status).toBe('mapped_unverified');
    });
  });

  describe('calculateMappingConfidenceCap (auto-map rows stay <= 0.80)', () => {
    test('no identifier caps at 0.50', () => {
      expect(calculateMappingConfidenceCap({}, false)).toBe(0.5);
    });
    test('identifier without package caps at 0.70', () => {
      expect(calculateMappingConfidenceCap({ vendor_sku: 'X' }, false)).toBe(0.7);
    });
    test('identifier + package, unverified caps at 0.80', () => {
      expect(calculateMappingConfidenceCap({ vendor_sku: 'X', package_size_value: 20, package_size_unit: 'oz', purchase_uom: 'each' }, false)).toBe(0.8);
    });
  });
});
