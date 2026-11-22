// The receipt / report email's closing line (GATE_DOC_CROSS_SELL_EMAIL,
// owner 2026-11-21): it names only the cards the customer will find behind
// the link, never a price, and is absent with the gate off. Two shapes: a
// page that holds both cards (the service report, one link), and the Waves
// app (the receipt email, owner 2026-11-22: one link for each card's tab,
// with no token in either).
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { docOfferEmailLine, joinBodyAppends } = require('../services/doc-offer-email-line');

// The report's card carries more than the line reads; the receipt's card is
// the cut-down link card. The line reads the label, and for the app also
// the relationship and whether the card carries a price.
const OFFER = { serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', option: { perVisit: 62.5 } };
const LINK_CARD = { label: 'Lawn Care', relationship: 'add', perApplication: 62.5 };
// Quote-only: a link page's card carries no per-application price (the app
// does not sell that offer to that customer in one tap).
const QUOTE_OFFER = { serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'quote_cta', relationship: 'add', option: null };
const QUOTE_CARD = { label: 'Lawn Care', relationship: 'add' };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const URL = 'https://portal.example/report/abc';
const APP = { offer: 'https://portal.example/?tab=billing', referral: 'https://portal.example/?tab=refer' };

beforeEach(() => isEnabled.mockImplementation((key) => key === 'docCrossSellEmail'));

describe('a page that holds the cards (the service report)', () => {
  // The report's card asks for an estimate in every mode (its button reads
  // "Request an Estimate"), so the line asks for a quote: never "Add" or
  // "Start", for a priced offer too.
  test.each([
    [{ crossSell: OFFER, referral: REFERRAL }, 'Get a quote for lawn care or refer a friend from your report'],
    [{ crossSell: OFFER }, 'Get a quote for lawn care from your report'],
    [{ referral: REFERRAL }, 'Know someone who could use Waves? Share your referral link from your report'],
    [{ crossSell: { ...OFFER, relationship: 'start' }, referral: REFERRAL }, 'Get a quote for lawn care or refer a friend from your report'],
    [{ crossSell: { ...OFFER, relationship: 'add' } }, 'Get a quote for lawn care from your report'],
    // A report offer that somehow carried a link card's price is still a
    // request on the report.
    [{ crossSell: { ...OFFER, perApplication: 62.5 } }, 'Get a quote for lawn care from your report'],
    [{ crossSell: QUOTE_OFFER, referral: REFERRAL }, 'Get a quote for lawn care or refer a friend from your report'],
    [{ crossSell: QUOTE_OFFER }, 'Get a quote for lawn care from your report'],
    [{ crossSell: { ...QUOTE_OFFER, relationship: 'start' } }, 'Get a quote for lawn care from your report'],
  ])('names only what the page shows: %j', (cards, lead) => {
    const line = docOfferEmailLine({ ...cards, url: URL, place: 'report' });
    expect(line.text).toBe(`${lead}: ${URL}`);
    expect(line.html).toContain(`href="${URL}"`);
    // Never a price in an email.
    expect(`${line.text}${line.html}`).not.toMatch(/\$|62\.5/);
    expect(`${line.text}${line.html}`).not.toMatch(/Add |Start /);
  });

  test('no cards, no line; no url or place, no line', () => {
    expect(docOfferEmailLine({ url: URL, place: 'report' })).toBeNull();
    expect(docOfferEmailLine({ crossSell: OFFER, place: 'report' })).toBeNull();
    expect(docOfferEmailLine({ crossSell: OFFER, url: URL })).toBeNull();
  });
});

describe('the Waves app (the receipt email)', () => {
  test('both cards: one link for each, each to its own tab', () => {
    const line = docOfferEmailLine({ crossSell: LINK_CARD, referral: REFERRAL, appUrls: APP });
    expect(line.text).toBe(`Add lawn care to your plan in the Waves app: ${APP.offer}\nTo refer a friend, get your referral link: ${APP.referral}`);
    expect(line.html).toContain(`href="${APP.offer}"`);
    expect(line.html).toContain(`href="${APP.referral}"`);
  });

  test('the offer alone: the Billing tab link, and no word about a referral', () => {
    const line = docOfferEmailLine({ crossSell: LINK_CARD, appUrls: APP });
    expect(line.text).toBe(`Add lawn care to your plan in the Waves app: ${APP.offer}`);
    expect(`${line.text}${line.html}`).not.toMatch(/refer/i);
  });

  test('the referral alone: the Refer tab link, and no word about a service', () => {
    const line = docOfferEmailLine({ referral: REFERRAL, appUrls: APP });
    expect(line.text).toBe(`Know someone who could use Waves? Get your referral link in the Waves app: ${APP.referral}`);
    expect(line.html).toContain(`href="${APP.referral}"`);
    expect(`${line.text}${line.html}`).not.toMatch(/tab=billing|plan/i);
  });

  test('a customer with no plan reads "Start"', () => {
    const line = docOfferEmailLine({ crossSell: { ...LINK_CARD, relationship: 'start' }, appUrls: APP });
    expect(line.text).toBe(`Start lawn care in the Waves app: ${APP.offer}`);
  });

  // The app shows a quote-only offer as a quote request. The line says so,
  // in its words and in its link.
  test.each([
    ['with the referral card', { crossSell: QUOTE_CARD, referral: REFERRAL }, `Get a quote for lawn care in the Waves app: ${APP.offer}\nTo refer a friend, get your referral link: ${APP.referral}`],
    ['alone', { crossSell: QUOTE_CARD }, `Get a quote for lawn care in the Waves app: ${APP.offer}`],
    ['for a customer with no plan', { crossSell: { ...QUOTE_CARD, relationship: 'start' } }, `Get a quote for lawn care in the Waves app: ${APP.offer}`],
  ])('a quote-only offer %s asks for a quote, never "Add" or "Start"', (_label, cards, text) => {
    const line = docOfferEmailLine({ ...cards, appUrls: APP });
    expect(line.text).toBe(text);
    expect(line.html).toContain('>ask for a quote</a>');
    expect(`${line.text}${line.html}`).not.toMatch(/Add |Start |see your offer/);
  });

  // A report-shaped offer (a `mode`, no card price) in the app shape is not
  // an offer the app sells now: the card's price is the only yes.
  test('an offer with no card price asks for a quote, whatever its mode says', () => {
    const line = docOfferEmailLine({ crossSell: { ...OFFER, relationship: 'add' }, appUrls: APP });
    expect(line.text).toBe(`Get a quote for lawn care in the Waves app: ${APP.offer}`);
  });

  test('a priced offer keeps its own link words', () => {
    const line = docOfferEmailLine({ crossSell: LINK_CARD, appUrls: APP });
    expect(line.html).toContain('>see your offer</a>');
    expect(line.html).not.toContain('ask for a quote');
  });

  test('never a price, and no cards means no line', () => {
    const line = docOfferEmailLine({ crossSell: LINK_CARD, referral: REFERRAL, appUrls: APP });
    expect(`${line.text}${line.html}`).not.toMatch(/\$|62\.5/);
    expect(docOfferEmailLine({ appUrls: APP })).toBeNull();
  });
});

test('gate off: no line in either shape', () => {
  isEnabled.mockReturnValue(false);
  expect(docOfferEmailLine({ crossSell: OFFER, referral: REFERRAL, url: URL, place: 'report' })).toBeNull();
  expect(docOfferEmailLine({ crossSell: LINK_CARD, referral: REFERRAL, appUrls: APP })).toBeNull();
});

test('joinBodyAppends keeps order and drops empties', () => {
  const a = { html: 'A', text: 'a' };
  const b = { html: 'B', text: 'b' };
  expect(joinBodyAppends(null, b)).toBe(b);
  expect(joinBodyAppends(a, b)).toEqual({ html: 'A<br><br>B', text: 'a\n\nb' });
  expect(joinBodyAppends(null, null)).toBeNull();
});
