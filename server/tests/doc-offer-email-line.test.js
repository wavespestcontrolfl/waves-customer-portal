// The receipt / report email's pointer line (GATE_DOC_CROSS_SELL_EMAIL,
// owner 2026-11-21): it names only the cards the linked page shows, never
// a price, and is absent with the gate off.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { docOfferEmailLine, joinBodyAppends } = require('../services/doc-offer-email-line');

const OFFER = { serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', option: { perVisit: 62.5 } };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const URL = 'https://portal.example/receipt/abc';

beforeEach(() => isEnabled.mockImplementation((key) => key === 'docCrossSellEmail'));

test.each([
  [{ crossSell: OFFER, referral: REFERRAL }, 'Add lawn care to your plan or refer a friend from your receipt'],
  [{ crossSell: OFFER }, 'Add lawn care to your plan from your receipt'],
  [{ referral: REFERRAL }, 'Know someone who could use Waves? Share your referral link from your receipt'],
])('names only what the page shows: %j', (cards, lead) => {
  const line = docOfferEmailLine({ ...cards, url: URL, place: 'receipt' });
  expect(line.text).toBe(`${lead}: ${URL}`);
  expect(line.html).toContain(`href="${URL}"`);
  // Never a price in an email.
  expect(`${line.text}${line.html}`).not.toMatch(/\$|62\.5/);
});

test('no cards, no line; gate off, no line', () => {
  expect(docOfferEmailLine({ url: URL, place: 'receipt' })).toBeNull();
  isEnabled.mockReturnValue(false);
  expect(docOfferEmailLine({ crossSell: OFFER, referral: REFERRAL, url: URL, place: 'receipt' })).toBeNull();
});

test('joinBodyAppends keeps order and drops empties', () => {
  const a = { html: 'A', text: 'a' };
  const b = { html: 'B', text: 'b' };
  expect(joinBodyAppends(null, b)).toBe(b);
  expect(joinBodyAppends(a, b)).toEqual({ html: 'A<br><br>B', text: 'a\n\nb' });
  expect(joinBodyAppends(null, null)).toBeNull();
});
