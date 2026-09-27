jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { targetFacts } = require('../services/content/internal-link-target-planner');

const corpus = [
  { url: '/termite-control-bradenton-fl/', body: '---\ntitle: "Termite Control in Bradenton, FL"\n---\nBody.' },
  { url: '/pest-control/neem-oil-for-whiteflies/', body: '---\ntitle: "Neem Oil for Whiteflies"\nprimary_keyword: neem oil for whiteflies\n---\nBody.' },
];

test('city-service titles become service + city anchor facts, never GSC query text', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/termite-control-bradenton-fl/', corpus)).toEqual({
    url: '/termite-control-bradenton-fl/',
    title: 'Termite Control in Bradenton, FL',
    keyword: 'termite control in bradenton',
    service: 'termite control',
    city: 'Bradenton',
  });
});

test('pages with their own keyword keep it', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/pest-control/neem-oil-for-whiteflies/', corpus))
    .toMatchObject({ keyword: 'neem oil for whiteflies', service: undefined, city: undefined });
});

test('a page missing from the corpus is not planned', () => {
  expect(targetFacts('https://www.wavespestcontrol.com/gone/', corpus)).toBeNull();
});
