// The mosquito Service Details guide (estimate-service-details.js mosquito) follows the protocol and the owner's
// later rulings. Found by the mosquito outline review (2026-10-26).
//
// Pins: the tool is a backpack sprayer, never "misting" (the misting system is a separate product, off until spring
// 2027); the protocol's flat rule keeps adult sprays off edible plants, open water and blooms with pollinators; the
// guide prints mosquito safety copy, not the shared crack-and-crevice section; no Bifen I/T bottle (Talak is the
// bifenthrin on the truck); Bti dunks and mosquito stations only when the estimate includes them (priced add-ons);
// rain speaks to effectiveness only, with no re-service promise or prompt to contact us (owner 2026-10-22 "rain
// washing a treatment off = we do NOT come back", 2026-10-24 "i dont want to prompt them to call us back because of
// rain"). Every changed line passes the customer-copy screens.

jest.mock('../models/db', () => {
  const chain = () => {
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      select: jest.fn(() => q),
      orderBy: jest.fn(() => Promise.resolve([])),
    };
    return q;
  };
  return jest.fn((table) => {
    if (table === 'products_catalog') return chain();
    if (table === 'service_product_usage') {
      const q = { whereIn: jest.fn(() => q), select: jest.fn(() => Promise.resolve([])) };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
});

const { SERVICE_DETAILS_COPY, buildServiceDetailsContent } = require('../services/estimate-service-details');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const mosquito = SERVICE_DETAILS_COPY.mosquito;
const faq = (pattern) => mosquito.faq.find((item) => pattern.test(item.q)).a;
const row = (label) => mosquito.systemBox.rows.find(([name]) => name === label)[1];
const ADD_ONS = 'Bti dunks and mosquito stations when your estimate includes them';

describe('mosquito guide follows the protocol and the owner rulings', () => {
  test('a backpack sprayer, and no misting words anywhere in the guide', () => {
    expect(mosquito.process[0]).toContain('We direct treatment there with a gas-powered backpack sprayer that places fine, labeled spray droplets');
    expect(JSON.stringify(mosquito)).not.toMatch(/\bmist(ing|er|s)?\b/i);
  });

  test('adult sprays stay off edible plants, open water and blooms with pollinators', () => {
    expect(faq(/pollinators/)).toContain('Adult sprays are kept off edible plants and open water, and off blooming plants where pollinators are active.');
    expect(faq(/pollinators/)).not.toContain('unless the specific label permits');
  });

  test('the built guide prints the mosquito safety section, not the shared crack-and-crevice one', async () => {
    const content = await buildServiceDetailsContent('mosquito', {});
    expect(content.safety).toBe(mosquito.safetyOverride);
    const safety = JSON.stringify(content.safety);
    expect(safety).not.toMatch(/crack-and-crevice|wall voids|behind appliances|perimeter products|fractions of an ounce/i);
    expect(content.safety.bullets).toContain('Blooming plants with active pollinators, edible plants, and open water are not sprayed. Larvicides are the one deliberate water application, used only on eligible sites. Tell us about beehives, butterfly gardens, edible plants, and fish ponds before service.');
  });

  test('no Bifen I/T bottle on the mosquito guide', () => {
    expect(mosquito.productImages.images.map((image) => image.file)).toEqual(['product-scion.png', 'product-tekko-pro.png']);
  });

  test('Bti dunks and mosquito stations only when the estimate includes them', () => {
    expect(row('Larval control')).toMatch(new RegExp(`; ${ADD_ONS}$`));
    expect(mosquito.included).toContain(`Label-directed larval treatment of eligible water sources within the covered area; ${ADD_ONS}`);
  });

  test('rain: effectiveness only, no re-service and no prompt to contact us', () => {
    const rain = faq(/rains/);
    expect(rain).toContain('No exterior treatment is weatherproof: a spray needs to dry and bond to the foliage, and after that it holds up to weather.');
    expect(rain).not.toMatch(/re-service|contact us|text us|call us|come back|compromised/i);
  });

  test('every changed line passes the customer-copy screens', () => {
    const changed = [
      mosquito.process[0],
      faq(/pollinators/),
      faq(/rains/),
      row('Larval control'),
      mosquito.included.find((line) => line.endsWith(ADD_ONS)),
      mosquito.safetyOverride.heading,
      ...mosquito.safetyOverride.paragraphs,
      ...mosquito.safetyOverride.bullets,
      mosquito.safetyOverride.closing,
    ];
    for (const line of changed) {
      expect({ line, banned: findBannedCustomerCopy(line) }).toEqual({ line, banned: [] });
      expect({ line, valid: validateCustomerCopy(line) }).toEqual({ line, valid: true });
    }
  });
});
