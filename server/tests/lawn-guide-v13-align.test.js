// The lawn "Service Details" guide must not contradict the live v13 lawn protocol
// (mowing around weed sprays, water-in for the weed barrier, summer work, zoysia height,
// the May insect pass, and the micronutrient product). Owner 2026-10-26.
jest.mock('../models/db', () => jest.fn());
const { SERVICE_DETAILS_COPY } = require('../services/estimate-service-details');

const lawnText = JSON.stringify(SERVICE_DETAILS_COPY.lawn_care);

describe('lawn guide matches v13', () => {
  test.each([
    'Mow at least 24 hours',
    'Don’t run the sprinklers after a visit',
    'Zoysia 1.75',
    'product-lesco-am-micros.png',
    'Chelated AM',
  ])('no longer contains %s', (needle) => {
    expect(lawnText).not.toContain(needle);
  });

  test.each([
    'A weed barrier needs about ½ inch of rain or irrigation within 14 days to activate; your regular watering counts.',
    'Zoysia 1.5–2\\"',
    'Mow at least 2 days before if mowing is due, and wait 2 days after.',
    'Wait 2 days after a weed spray and 1 day after other liquid applications',
    'The one planned exception is May, peak chinch bug season',
    'weed control where label limits allow, with micronutrients for color where your ordinance allows them.',
  ])('contains %s', (needle) => {
    expect(lawnText).toContain(needle);
  });

  test('still lists three product images', () => {
    expect(SERVICE_DETAILS_COPY.lawn_care.productImages.images.map((i) => i.file)).toEqual([
      'product-lesco-fertilizer-bag.png',
      'product-celsius-wg.png',
      'product-arena-50-wdg.png',
    ]);
  });
});
