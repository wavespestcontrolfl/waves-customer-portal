// The cards a public link page shows (receipt, tracker; GATE_DOC_CROSS_SELL,
// owner 2026-11-21) are links into the Waves app (owner 2026-11-22). This
// suite pins the three pieces both pages share:
//   - the offer is the one the APP shows the customer: the app route's own
//     gate, then the app's own composer (appOfferForCustomer), so a page
//     never names an offer the Billing tab will not show;
//   - a card carries only what the page prints (publicOfferCard);
//   - which accounts send their links to other people by their own setup
//     (linkReachesOnlyAccountHolder).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/cross-sell', () => ({ buildPortalOffer: jest.fn() }));
jest.mock('../services/referral-share', () => ({ composeReferralCard: jest.fn() }));

const db = require('../models/db');
const { buildPortalOffer } = require('../services/service-report/cross-sell');
const referralShare = require('../services/referral-share');
const { appOfferForCustomer } = require('../services/property-recommendations');
const { linkReachesOnlyAccountHolder, publicOfferCard, appLinkCardsForCustomer } = require('../services/app-link-cards');

const APP_OFFER = {
  serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add',
  option: { id: 'lawn-enhanced', perVisit: 62, cadence: 'monthly', tier: 'Silver' }, fingerprint: 'fp',
};
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PROPERTY_RECOMMENDATIONS = 'true';
  buildPortalOffer.mockResolvedValue(APP_OFFER);
  referralShare.composeReferralCard.mockResolvedValue(REFERRAL);
});
afterAll(() => { delete process.env.GATE_PROPERTY_RECOMMENDATIONS; });

describe('appOfferForCustomer — the offer the app shows', () => {
  test('gate on: the app\'s own composer, for that customer', async () => {
    expect(await appOfferForCustomer('cust-1')).toBe(APP_OFFER);
    expect(buildPortalOffer).toHaveBeenCalledWith('cust-1', db);
  });

  // The app's route answers { available: false } with this gate off, so the
  // Billing tab shows no offer card: a link page must not name one.
  test.each([['unset', undefined], ['false', 'false']])('GATE_PROPERTY_RECOMMENDATIONS %s: no offer, and nothing is priced', async (_label, value) => {
    if (value === undefined) delete process.env.GATE_PROPERTY_RECOMMENDATIONS;
    else process.env.GATE_PROPERTY_RECOMMENDATIONS = value;
    expect(await appOfferForCustomer('cust-1')).toBeNull();
    expect(buildPortalOffer).not.toHaveBeenCalled();
  });

  test('no customer id: no offer', async () => {
    expect(await appOfferForCustomer(null)).toBeNull();
    expect(buildPortalOffer).not.toHaveBeenCalled();
  });
});

describe('publicOfferCard — only what the page prints', () => {
  test('a priced offer: the service, add or start, and the per-application price', () => {
    expect(publicOfferCard(APP_OFFER)).toEqual({ label: 'Lawn Care', relationship: 'add', perApplication: 62 });
    expect(publicOfferCard({ ...APP_OFFER, relationship: 'start' }).relationship).toBe('start');
  });

  test.each([
    ['a quote-only offer', { ...APP_OFFER, mode: 'quote_cta', option: null }],
    ['a priced offer with no usable price', { ...APP_OFFER, option: { id: 'x', perVisit: 0 } }],
    ['a price on an offer that is not priced', { ...APP_OFFER, mode: 'quote_cta' }],
  ])('%s carries no price', (_label, offer) => {
    expect(publicOfferCard(offer)).toEqual({ label: 'Lawn Care', relationship: 'add' });
  });

  test.each([
    ['no offer', null],
    ['an offer with no service', { ...APP_OFFER, serviceKey: '' }],
    ['an offer with no label', { ...APP_OFFER, label: '' }],
  ])('%s → no card', (_label, offer) => {
    expect(publicOfferCard(offer)).toBeNull();
  });
});

describe('appLinkCardsForCustomer', () => {
  test('both cards, each built for the same customer', async () => {
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({
      crossSell: { label: 'Lawn Care', relationship: 'add', perApplication: 62 },
      referral: REFERRAL,
    });
    expect(buildPortalOffer).toHaveBeenCalledWith('cust-1', db);
    expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
  });

  test('the app\'s offer gate off: the referral card alone', async () => {
    delete process.env.GATE_PROPERTY_RECOMMENDATIONS;
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({ referral: REFERRAL });
  });

  test('no offer and no referral program: no cards', async () => {
    buildPortalOffer.mockResolvedValue(null);
    referralShare.composeReferralCard.mockResolvedValue(null);
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({});
  });
});

describe('linkReachesOnlyAccountHolder', () => {
  const HOLDER = { id: 'cust-1' };
  test('an account with no payer and no service contact', () => {
    expect(linkReachesOnlyAccountHolder(HOLDER, [null, undefined])).toBe(true);
  });

  test.each([
    ['a payer on any of the places asked', HOLDER, [null, 7]],
    ['a service contact with a phone', { ...HOLDER, service_contact_name: 'Tenant', service_contact_phone: '+19415550100' }, []],
    ['a second service contact with an email', { ...HOLDER, service_contact2_name: 'Manager', service_contact2_email: 'm@example.com' }, []],
    ['no row', null, []],
  ])('%s → false', (_label, row, payerIds) => {
    expect(linkReachesOnlyAccountHolder(row, payerIds)).toBe(false);
  });

  test('a service contact name with no phone and no email gets no link', () => {
    expect(linkReachesOnlyAccountHolder({ ...HOLDER, service_contact_name: 'Tenant' }, [])).toBe(true);
  });
});
