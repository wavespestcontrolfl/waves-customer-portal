// Per-service details packet (GATE_SERVICE_DETAILS_PDF): content assembly
// filters the public product registry to the service line, and the PDF
// renderer produces a real document for every supported service — with and
// without registry rows (the packet must never depend on registry seeding).

jest.mock('../models/db', () => {
  const rows = { products: [], usage: [] };
  const chain = (result) => {
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      select: jest.fn(() => q),
      orderBy: jest.fn(() => Promise.resolve(result())),
    };
    return q;
  };
  const db = jest.fn((table) => {
    if (table === 'products_catalog') return chain(() => rows.products);
    if (table === 'service_product_usage') {
      const q = {
        whereIn: jest.fn(() => q),
        select: jest.fn(() => Promise.resolve(rows.usage)),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  db.__rows = rows;
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  SERVICE_DETAILS_COPY,
  serviceDetailsAvailable,
  buildServiceDetailsContent,
} = require('../services/estimate-service-details');
const { renderServiceDetailsPdf } = require('../services/pdf/service-details-pdf');

const PRODUCT = {
  id: 'p1',
  name: 'Suspend PolyZone',
  common_name: 'Deltamethrin barrier',
  active_ingredient: 'Deltamethrin 4.75%',
  formulation: 'SC',
  epa_reg_number: '432-1514',
  signal_word: 'CAUTION',
  public_summary: 'Long-lasting exterior barrier treatment.',
  customer_safety_summary: null,
  pet_kid_guidance_text: 'Safe once dry.',
  reentry_text: 'Re-enter treated areas once dry (about 1 hour).',
  label_url: 'https://example.com/label.pdf',
  sds_url: 'https://example.com/sds.pdf',
};

beforeEach(() => {
  db.__rows.products = [];
  db.__rows.usage = [];
});

describe('estimate-service-details content assembly', () => {
  test('every supported service has copy with included + process bullets', () => {
    for (const [key, copy] of Object.entries(SERVICE_DETAILS_COPY)) {
      expect(serviceDetailsAvailable(key)).toBe(true);
      expect(copy.title).toMatch(/Service Details$/);
      expect(copy.included.length).toBeGreaterThan(0);
      expect(copy.process.length).toBeGreaterThan(0);
    }
    expect(serviceDetailsAvailable('rodent_bait')).toBe(false);
    expect(serviceDetailsAvailable('nope')).toBe(false);
  });

  test('registry products are filtered to the service line by usage pattern', async () => {
    db.__rows.products = [PRODUCT, { ...PRODUCT, id: 'p2', name: 'Lawn Only Product' }];
    db.__rows.usage = [
      { product_id: 'p1', service_type: 'Quarterly Pest Control' },
      { product_id: 'p2', service_type: 'Lawn Care' },
    ];
    const content = await buildServiceDetailsContent('pest_control', { customer_name: 'Javier', address: '123 Way' });
    expect(content.products.map((p) => p.id)).toEqual(['p1']);
    expect(content.title).toBe('Pest Protection — Service Details');
    const lawn = await buildServiceDetailsContent('lawn_care', {});
    expect(lawn.products.map((p) => p.id)).toEqual(['p2']);
  });

  test('unknown service returns null; registry failure degrades to empty list', async () => {
    expect(await buildServiceDetailsContent('rodent_bait', {})).toBeNull();
  });
});

describe('service-details PDF renderer', () => {
  test('renders a real PDF with products', async () => {
    db.__rows.products = [PRODUCT];
    db.__rows.usage = [{ product_id: 'p1', service_type: 'General Pest Perimeter' }];
    const content = await buildServiceDetailsContent('pest_control', {
      customer_name: 'Javier Rigtest',
      address: '123 Monitoring Way, Sarasota, FL 34235',
      estimate_slug: 'EST-2026-0002',
    });
    const buffer = await renderServiceDetailsPdf(content);
    expect(buffer.length).toBeGreaterThan(1500);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('renders for every supported service with an EMPTY registry (fallback note path)', async () => {
    for (const key of Object.keys(SERVICE_DETAILS_COPY)) {
      const content = await buildServiceDetailsContent(key, {});
      const buffer = await renderServiceDetailsPdf(content);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});
