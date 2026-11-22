// @vitest-environment jsdom
// The add-a-service card and the referral card on a public link page (the
// receipt, the tracker; GATE_DOC_CROSS_SELL). Owner 2026-11-22: each card
// only opens the Waves app, because a receipt or tracker link can reach
// people other than the customer. This file pins that the cards are plain
// links with no token, that nothing is posted, and what each card prints.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppLinkCards, { APP_OFFER_PATH, APP_REFERRAL_PATH, appCardHref, appOfferPriceLine } from './AppLinkCards';

const OFFER = { label: 'Lawn Care', relationship: 'add', perApplication: 62 };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };

beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AppLinkCards', () => {
  it('the offer card names the service and its per-application price, and links to the app\'s Billing tab', () => {
    render(<AppLinkCards offer={OFFER} />);
    expect(screen.getByRole('heading', { name: 'Add lawn care to your plan' })).toBeInTheDocument();
    expect(screen.getByText('$62 per application, priced for your home')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is booked or charged until you confirm it there\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open the Waves app' });
    expect(link).toHaveAttribute('href', '/?tab=billing');
    expect(APP_OFFER_PATH).toBe('/?tab=billing');
  });

  it('a customer with no plan reads "Start", never "Add ... to your plan"', () => {
    render(<AppLinkCards offer={{ ...OFFER, relationship: 'start' }} />);
    expect(screen.getByRole('heading', { name: 'Start lawn care' })).toBeInTheDocument();
    expect(screen.queryByText(/to your plan/)).not.toBeInTheDocument();
  });

  it('a quote-only offer shows no price', () => {
    render(<AppLinkCards offer={{ label: 'Pest Control', relationship: 'add' }} />);
    expect(screen.getByRole('heading', { name: 'Want a quote for pest control?' })).toBeInTheDocument();
    expect(screen.queryByText(/\$|per application/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Waves app' })).toHaveAttribute('href', '/?tab=billing');
  });

  it('the referral card prints the program\'s own words and links to the app\'s Refer tab', () => {
    render(<AppLinkCards referral={{ ...REFERRAL, offer: 'Your friend gets $50. You get $25.' }} />);
    expect(screen.getByRole('heading', { name: REFERRAL.headline })).toBeInTheDocument();
    expect(screen.getByText('Your friend gets $50. You get $25.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Send My Referral Link' });
    expect(link).toHaveAttribute('href', '/?tab=refer');
    expect(APP_REFERRAL_PATH).toBe('/?tab=refer');
  });

  // One login can hold more than one customer profile, and the app opens on
  // the profile the holder last used. The server's link names the profile
  // the card was composed for; the app's route guard switches to it.
  it('each card uses the server\'s link, which names the customer profile', () => {
    render(
      <AppLinkCards
        offer={{ ...OFFER, href: '/?tab=billing&notificationProperty=cust-1' }}
        referral={{ ...REFERRAL, href: '/?tab=refer&notificationProperty=cust-1' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open the Waves app' })).toHaveAttribute('href', '/?tab=billing&notificationProperty=cust-1');
    expect(screen.getByRole('link', { name: 'Send My Referral Link' })).toHaveAttribute('href', '/?tab=refer&notificationProperty=cust-1');
  });

  it.each([
    ['no link in the payload', undefined],
    ['another site', 'https://example.test/?tab=billing&notificationProperty=cust-1'],
    ['another page of this site', '/pay/tok-1'],
    ['the other card\'s tab', '/?tab=refer&notificationProperty=cust-1'],
    ['a tab link with something else than a profile', '/?tab=billing&next=/pay/tok-1'],
    ['not a string', { toString: () => '/?tab=billing&notificationProperty=cust-1' }],
  ])('a card link that is not this tab\'s own profile link (%s) falls back to the bare tab', (_label, href) => {
    expect(appCardHref({ href }, APP_OFFER_PATH)).toBe('/?tab=billing');
    render(<AppLinkCards offer={{ ...OFFER, href }} />);
    expect(screen.getByRole('link', { name: 'Open the Waves app' })).toHaveAttribute('href', '/?tab=billing');
  });

  it('both cards: the offer first, then the referral', () => {
    const { container } = render(<AppLinkCards offer={OFFER} referral={REFERRAL} />);
    const sections = [...container.querySelectorAll('section')].map((s) => s.getAttribute('data-section'));
    expect(sections).toEqual(['cross-sell', 'referral']);
  });

  // A receipt or tracker link is a bearer link: a card must never act from
  // it. No button, no form, no request, and no token in either link.
  it('nothing on a card acts: only links, no button, and a click sends no request', () => {
    const { container } = render(<AppLinkCards offer={OFFER} referral={REFERRAL} />);
    expect(container.querySelectorAll('button, form, input')).toHaveLength(0);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/?tab=billing', '/?tab=refer']);
    for (const a of links) {
      a.addEventListener('click', (e) => e.preventDefault());
      fireEvent.click(a);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no payload keys', {}],
    ['an offer with no label', { offer: { relationship: 'add' } }],
    ['a referral with no headline', { referral: { cta: 'Send My Referral Link' } }],
  ])('%s renders nothing', (_label, props) => {
    const { container } = render(<AppLinkCards {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the host page\'s styles reach the card and its link', () => {
    const { container } = render(
      <AppLinkCards offer={OFFER} style={{ marginTop: 16 }} styles={{ button: { textDecoration: 'none' } }} />,
    );
    expect(container.querySelector('section')).toHaveStyle({ marginTop: '16px' });
    expect(screen.getByRole('link', { name: 'Open the Waves app' })).toHaveStyle({ textDecoration: 'none' });
  });
});

describe('appOfferPriceLine', () => {
  it.each([
    [{ perApplication: 62 }, '$62 per application'],
    [{ perApplication: 62.5 }, '$62.50 per application'],
    [{ perApplication: 0 }, null],
    [{ perApplication: '62' }, '$62 per application'],
    [{}, null],
    [null, null],
  ])('%j → %s', (offer, expected) => {
    expect(appOfferPriceLine(offer)).toBe(expected);
  });
});
