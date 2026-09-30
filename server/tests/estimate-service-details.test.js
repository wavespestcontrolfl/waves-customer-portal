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
  }, 30000);

  test('product-image callouts obey the public-registry chokepoint', async () => {
    // With an EMPTY registry, every image that names a specific product is
    // filtered out — a name the owner hasn't approved for the public
    // registry must not leak through a caption (codex #2611).
    const mosquito = await buildServiceDetailsContent('mosquito', {});
    expect(mosquito.productImages).toBeNull();
    const termite = await buildServiceDetailsContent('termite_bait', {});
    expect(termite.productImages).toBeNull();
    // Generic imagery (no product name: surfactant, fertilizer bags) still
    // renders without registry approval.
    const pest = await buildServiceDetailsContent('pest_control', {});
    expect(pest.productImages.images.map((i) => i.file)).toEqual(['product-surfactant.png']);
    const lawn = await buildServiceDetailsContent('lawn_care', {});
    expect(lawn.productImages.images.map((i) => i.file)).toEqual([
      'product-lesco-fertilizer-bag.png',
      'product-lesco-am-micros.png',
    ]);
  });
});

describe('lawn_care guide (revised prep & service guide)', () => {
  const lawnStrings = (copy) => {
    const out = [];
    const walk = (node) => {
      if (typeof node === 'string') out.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    ['title', 'tagline', 'systemBox', 'sections', 'included', 'process', 'faq', 'safetyOverride',
      'responsibilities', 'complianceExtras', 'documentationOverride', 'ctaMicro', 'oneTime'].forEach((k) => walk(copy[k]));
    return out;
  };

  // An estimate that carries the Bermuda-suppression add-on (engine request
  // option — one of the shapes estimateDataCarriesBermudaSuppression reads).
  const BERMUDA_ESTIMATE = { estimate_data: { engineRequest: { options: { bermudaSuppression: true } } } };
  const withBermudaGate = async (value, fn) => {
    const prior = process.env.GATE_BERMUDA_SUPPRESSION;
    if (value == null) delete process.env.GATE_BERMUDA_SUPPRESSION; else process.env.GATE_BERMUDA_SUPPRESSION = value;
    try { return await fn(); } finally {
      if (prior == null) delete process.env.GATE_BERMUDA_SUPPRESSION; else process.env.GATE_BERMUDA_SUPPRESSION = prior;
    }
  };
  const isBermudaHeading = (h) => /^Bermuda removal from St\. Augustine/.test(h || '');

  test('carries ordered sections including a Bermuda section with a table', async () => {
    const lawn = await withBermudaGate('true', () => buildServiceDetailsContent('lawn_care', BERMUDA_ESTIMATE));
    expect(Array.isArray(lawn.sections)).toBe(true);
    const headings = lawn.sections.map((s) => s.heading);
    expect(headings.slice(0, 2)).toEqual(['Before your first visit', 'Before every visit']);
    // The visit walkthrough (included + process) is slotted between the prep
    // and the aftercare, as the owner-approved draft orders it.
    const slotAt = lawn.sections.findIndex((s) => s.slot === 'process');
    expect(slotAt).toBe(2);
    expect(lawn.sections[slotAt + 1].heading).toBe('After every visit');
    expect(headings.some(isBermudaHeading)).toBe(true);
    const tables = lawn.sections.filter((s) => s.table);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].table.columns).toEqual(['When', 'What’s happening', 'What you see']);
    expect(tables[0].table.rows.every((r) => r.length === 3)).toBe(true);
    expect(lawn.systemBox.rows).toHaveLength(7);
    expect(lawn.faq).toHaveLength(7);
    expect(lawn.responsibilities.heading).toBe('Not part of this service');
    expect(lawn.documentation.bullets).toHaveLength(3);
    // Other services do not gain sections.
    const pest = await buildServiceDetailsContent('pest_control', {});
    expect(pest.sections).toEqual([]);
  });

  test('Bermuda sections render only for an estimate carrying the add-on with the gate on (Codex r1 P1)', async () => {
    const bermudaHeadings = ['What has to be true first', 'What you do', 'What you’ll see'];
    const cases = [
      ['no add-on, gate on', 'true', {}],
      ['add-on, gate off', null, BERMUDA_ESTIMATE],
    ];
    for (const [, gate, estimate] of cases) {
      const lawn = await withBermudaGate(gate, () => buildServiceDetailsContent('lawn_care', estimate));
      const headings = lawn.sections.map((sec) => sec.heading);
      expect(headings.some(isBermudaHeading)).toBe(false);
      for (const h of bermudaHeadings) expect(headings).not.toContain(h);
      expect(lawn.sections.some((sec) => sec.table)).toBe(false);
      expect(JSON.stringify(lawn.sections)).not.toMatch(/priced into your estimate/);
    }
    const lawn = await withBermudaGate('true', () => buildServiceDetailsContent('lawn_care', BERMUDA_ESTIMATE));
    const headings = lawn.sections.map((sec) => sec.heading);
    for (const h of bermudaHeadings) expect(headings).toContain(h);
    // Markers never reach the renderers.
    for (const sec of lawn.sections) {
      expect(sec).not.toHaveProperty('requires');
      expect(sec).not.toHaveProperty('scope');
      for (const f of ['paragraphs', 'steps', 'bullets']) {
        for (const entry of sec[f] || []) expect(typeof entry).toBe('string');
      }
    }
  });

  test('CitraBlue waits on a test patch; watering never prescribes a static weekly cadence (Codex r1 P1)', async () => {
    const lawn = await withBermudaGate('true', () => buildServiceDetailsContent('lawn_care', BERMUDA_ESTIMATE));
    const text = JSON.stringify(lawn.sections);
    expect(text).toMatch(/CitraBlue: a test patch first, watched 3–4 weeks/);
    expect(text).not.toMatch(/SunClipse, and CitraBlue: yes/);
    const watering = lawn.sections.find((sec) => /^Watering your lawn/.test(sec.heading));
    expect(watering.paragraphs.join(' ')).not.toMatch(/\d\s*[–-]\s*\d\s+times a week/);
    expect(watering.paragraphs.join(' ')).toMatch(/watering restriction in force for your address/);
  });

  test('the one-time variant drops every recurring-program promise (Codex r1 P1)', async () => {
    const lawn = await withBermudaGate('true', () => buildServiceDetailsContent('lawn_care', {}, { lawnScope: 'one_time' }));
    expect(lawn.systemBox.heading).toBe('Your lawn service at a glance');
    expect(lawn.included).toEqual([]);
    expect(lawn.process).toEqual([]);
    expect(lawn.faq.map((f) => f.q)).toEqual([
      'Will my lawn be weed-free?', 'Can you fix thin grass under my trees?', 'What if you’re not sure what’s wrong?',
    ]);
    expect(lawn.responsibilities.bullets).not.toContain('Plugging, dethatching, and top dressing are quoted separately');
    const text = JSON.stringify({
      systemBox: lawn.systemBox, sections: lawn.sections, faq: lawn.faq, responsibilities: lawn.responsibilities, ctaMicro: lawn.ctaMicro,
    });
    expect(text).not.toMatch(/9–12|per year|re-service|no charge|comprehensive|program terms|summer visits|repeat treatments/i);
    expect(lawn.ctaMicro).toBe('The lawn work on your estimate · Documented in your service report');
    // Documentation drops the every-visit / lawn-health-history lines (Codex r2 P0).
    expect(lawn.documentation.heading).toBe('Documented — no mystery treatments, no missing paperwork');
    expect(JSON.stringify(lawn.documentation)).not.toMatch(/every visit|lawn-health|frequency|guarantee/i);
    // A Bermuda add-on flag left on the estimate (e.g. after a lawn removal)
    // never reaches the one-time guide.
    const leftover = await withBermudaGate('true', () => buildServiceDetailsContent('lawn_care', BERMUDA_ESTIMATE, { lawnScope: 'one_time' }));
    expect(leftover.sections.map((sec) => sec.heading).some(isBermudaHeading)).toBe(false);
    // The one-time aftercare line replaces the recurring one.
    const after = lawn.sections.find((sec) => sec.heading === 'After every visit');
    expect(after.bullets.filter((b) => /^Call us right away/.test(b))).toHaveLength(1);
    // Special-situation prep for the one-time jobs themselves stays.
    const headings = lawn.sections.map((sec) => sec.heading);
    expect(headings.some((h) => /^Plugging/.test(h))).toBe(true);
    expect(headings.some((h) => /^Dethatching/.test(h))).toBe(true);
    expect(headings.some((h) => /^Top dressing/.test(h))).toBe(true);
    // The recurring guide is unchanged by the variant.
    const recurring = await buildServiceDetailsContent('lawn_care', {});
    expect(recurring.systemBox.rows).toHaveLength(7);
    expect(recurring.faq).toHaveLength(7);
    // And it renders (no orphan "What's included" heading on empty lists).
    const pdf = await renderServiceDetailsPdf(lawn);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30000);

  test('renders a PDF for lawn_care that is larger with the sections than without', async () => {
    const lawn = await buildServiceDetailsContent('lawn_care', { customer_name: 'Test Customer', address: '1 Test Way' });
    const withSections = await renderServiceDetailsPdf(lawn);
    const without = await renderServiceDetailsPdf({ ...lawn, sections: [] });
    expect(withSections.subarray(0, 5).toString()).toBe('%PDF-');
    expect(withSections.length).toBeGreaterThan(without.length);
    const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    expect(pages(withSections)).toBeGreaterThan(pages(without));
    // The process slot renders included + process exactly once either way.
    const slotOnly = await renderServiceDetailsPdf({ ...lawn, sections: [{ slot: 'process' }] });
    expect(slotOnly.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Math.abs(slotOnly.length - without.length)).toBeLessThan(without.length * 0.05);
  }, 30000);

  test('all lawn copy obeys the product & safety standard', () => {
    const strings = lawnStrings(SERVICE_DETAILS_COPY.lawn_care);
    // EPA registration covers pesticides, not fertilizer (Codex r2 P1).
    expect(strings.join('\n')).not.toMatch(/every product we apply is EPA-registered/i);
    expect(strings.length).toBeGreaterThan(40);
    for (const text of strings) {
      expect(text).not.toMatch(/\bsafe(ly)?\b/i);
      expect(text).not.toMatch(/EPA[- ]approved/i);
      expect(text).not.toMatch(/per visit/i);
    }
    const joined = strings.join('\n');
    expect(joined).toMatch(/EPA-registered/);
    expect(joined).toMatch(/risk-free/);
  });
});
