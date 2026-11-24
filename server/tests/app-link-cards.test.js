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
jest.mock('../services/one-tap-purchase', () => ({ oneTapShownTo: jest.fn() }));

const db = require('../models/db');
const { buildPortalOffer } = require('../services/service-report/cross-sell');
const referralShare = require('../services/referral-share');
const { oneTapShownTo } = require('../services/one-tap-purchase');
const { appOfferForCustomer } = require('../services/property-recommendations');
const {
  linkReachesOnlyAccountHolder, appOpensForCustomer, appLinksForCustomer, publicOfferCard, appLinkCardsForCustomer,
} = require('../services/app-link-cards');

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
  oneTapShownTo.mockResolvedValue(true);
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
  test('a priced offer the app sells in one tap: the service, add or start, and the per-application price', () => {
    expect(publicOfferCard(APP_OFFER, { oneTap: true })).toEqual({ label: 'Lawn Care', relationship: 'add', perApplication: 62 });
    expect(publicOfferCard({ ...APP_OFFER, relationship: 'start' }, { oneTap: true }).relationship).toBe('start');
  });

  // Without one-tap the app's card asks for an estimate and names no price
  // (owner 2026-08-28), so the page's card must not name one either.
  test.each([
    ['one-tap off', { oneTap: false }],
    ['no one-tap answer', undefined],
    ['a truthy value that is not the answer', { oneTap: 'yes' }],
  ])('a priced offer the app only takes a request for (%s) carries no price', (_label, opts) => {
    expect(publicOfferCard(APP_OFFER, opts)).toEqual({ label: 'Lawn Care', relationship: 'add' });
  });

  test.each([
    ['a quote-only offer', { ...APP_OFFER, mode: 'quote_cta', option: null }],
    ['a priced offer with no usable price', { ...APP_OFFER, option: { id: 'x', perVisit: 0 } }],
    ['a price on an offer that is not priced', { ...APP_OFFER, mode: 'quote_cta' }],
  ])('%s carries no price', (_label, offer) => {
    expect(publicOfferCard(offer, { oneTap: true })).toEqual({ label: 'Lawn Care', relationship: 'add' });
  });

  test.each([
    ['no offer', null],
    ['an offer with no service', { ...APP_OFFER, serviceKey: '' }],
    ['an offer with no label', { ...APP_OFFER, label: '' }],
  ])('%s → no card', (_label, offer) => {
    expect(publicOfferCard(offer, { oneTap: true })).toBeNull();
  });
});

// A login account can hold more than one customer profile, and the app opens
// on the profile the holder last used. Each link names the profile the card
// was composed for, in the shape the app's route guard reads
// (client App.jsx resolveNotificationTarget: `notificationProperty`).
describe('appLinksForCustomer', () => {
  const PROFILE = '0b9d3b0e-6f0a-4c56-9d55-0d3f3f0f6a11';

  test('each tab link names the customer profile', () => {
    expect(appLinksForCustomer(PROFILE)).toEqual({
      offer: `/?tab=billing&notificationProperty=${PROFILE}`,
      referral: `/?tab=refer&notificationProperty=${PROFILE}`,
    });
  });

  test('the two links name the same profile and different tabs', () => {
    const { offer, referral } = appLinksForCustomer(PROFILE);
    const read = (href) => new URL(href, 'https://portal.example.test').searchParams;
    expect(read(offer).get('tab')).toBe('billing');
    expect(read(referral).get('tab')).toBe('refer');
    expect(read(offer).get('notificationProperty')).toBe(PROFILE);
    expect(read(referral).get('notificationProperty')).toBe(PROFILE);
    // No token of any kind: the app's sign-in is the only authorization.
    expect([...read(offer).keys()]).toEqual(['tab', 'notificationProperty']);
    expect([...read(referral).keys()]).toEqual(['tab', 'notificationProperty']);
  });
});

describe('appLinkCardsForCustomer', () => {
  const OFFER_HREF = '/?tab=billing&notificationProperty=cust-1';
  const REFERRAL_CARD = { ...REFERRAL, href: '/?tab=refer&notificationProperty=cust-1' };

  test('both cards, each built for the same customer and linked to that customer\'s profile', async () => {
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({
      crossSell: { label: 'Lawn Care', relationship: 'add', perApplication: 62, href: OFFER_HREF },
      referral: REFERRAL_CARD,
    });
    expect(buildPortalOffer).toHaveBeenCalledWith('cust-1', db);
    expect(oneTapShownTo).toHaveBeenCalledWith('cust-1', db);
    expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
  });

  // The app shows a price only on its one-tap purchase button.
  test('the app only takes a request from this customer: the offer card names no price', async () => {
    oneTapShownTo.mockResolvedValue(false);
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({
      crossSell: { label: 'Lawn Care', relationship: 'add', href: OFFER_HREF },
      referral: REFERRAL_CARD,
    });
  });

  test('the app\'s offer gate off: the referral card alone, and one-tap is never asked', async () => {
    delete process.env.GATE_PROPERTY_RECOMMENDATIONS;
    expect(await appLinkCardsForCustomer('cust-1')).toEqual({ referral: REFERRAL_CARD });
    expect(oneTapShownTo).not.toHaveBeenCalled();
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

// The cards open the Waves app, so they are for a customer the app opens
// those tabs for. A cancelled customer signs in to a read-only app with no
// Refer tab (the app's CANCELLED_TABS) and no offer; any other inactive or
// removed customer cannot sign in.
describe('appOpensForCustomer — the app opens the cards\' tabs for an active customer only', () => {
  test('an active customer: yes', () => {
    expect(appOpensForCustomer({ customer_active: true, customer_deleted_at: null })).toBe(true);
  });

  test.each([
    ['a cancelled customer', { customer_active: false }],
    ['no active flag on record', { customer_active: null }],
    ['a row that does not carry the flag', {}],
    ['a removed customer', { customer_active: true, customer_deleted_at: '2026-11-01T00:00:00Z' }],
    ['no row', null],
  ])('%s: no', (_label, row) => {
    expect(appOpensForCustomer(row)).toBe(false);
  });
});
