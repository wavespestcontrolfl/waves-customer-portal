// @vitest-environment jsdom
// The shared add-a-service card (report, receipt, tracker — owner
// 2026-11-21): a priced offer shows its per-application price on surfaces
// that allow it; the report keeps its price-free copy (owner 2026-10-05);
// the tap posts exactly what was shown and only follows a same-origin
// estimate link.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CrossSellOfferCard, { crossSellPriceLine } from './CrossSellOfferCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const priced = {
  serviceKey: 'lawn_care',
  label: 'Lawn Care',
  mode: 'priced',
  relationship: 'add',
  option: { id: 'lawn-enhanced', perVisit: 62.5, waveguardTier: 'silver' },
  fingerprint: 'fp-1',
};
const quote = { ...priced, mode: 'quote_cta', option: null };

describe('crossSellPriceLine', () => {
  it('is per application only, and absent for an unpriced offer', () => {
    expect(crossSellPriceLine(priced)).toBe('$62.50 per application');
    expect(crossSellPriceLine({ ...priced, option: { ...priced.option, perVisit: 45 } })).toBe('$45 per application');
    expect(crossSellPriceLine(quote)).toBeNull();
    expect(crossSellPriceLine({ ...priced, option: { perVisit: 0 } })).toBeNull();
  });
});

describe('CrossSellOfferCard', () => {
  it('shows the home price on a priced offer', () => {
    render(<CrossSellOfferCard offer={priced} submit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Add lawn care to your plan' })).toBeInTheDocument();
    expect(screen.getByText('$62.50 per application, priced for your home')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get my estimate' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\/mo|a month|per visit/i);
  });

  // A one-time customer has no plan to add to: the server marks that offer
  // relationship 'start', and the priced heading follows it.
  it('a priced offer for a customer with no plan says "Start", not "Add … to your plan"', () => {
    render(<CrossSellOfferCard offer={{ ...priced, relationship: 'start' }} submit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Start lawn care' })).toBeInTheDocument();
    expect(screen.getByText('$62.50 per application, priced for your home')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/to your plan/i);
  });

  it('showPrice={false} keeps the report\'s price-free copy', () => {
    render(<CrossSellOfferCard offer={priced} submit={vi.fn()} showPrice={false} />);
    expect(screen.getByRole('heading', { name: 'Want a quote for lawn care?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request an Estimate' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$62.50');
  });

  it('an unpriced offer asks for a quote with no price', () => {
    render(<CrossSellOfferCard offer={quote} submit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Want a quote for lawn care?' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$');
  });

  it('the tap posts what was shown and follows a same-origin estimate link', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: window.location.origin, assign });
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { ok: true, estimateUrl: '/estimate/abc' } });
    render(<CrossSellOfferCard offer={priced} submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get my estimate' }));
    await waitFor(() => expect(screen.getByText(/Request received/)).toBeInTheDocument());
    expect(submit).toHaveBeenCalledWith({
      serviceKey: 'lawn_care',
      serviceLabel: 'Lawn Care',
      optionId: 'lawn-enhanced',
      perApplication: 62.5,
      offerMode: 'priced',
      fingerprint: 'fp-1',
    });
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/estimate/abc`);
  });

  it('never navigates cross-origin', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: window.location.origin, assign });
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { estimateUrl: 'https://evil.example/x' } });
    render(<CrossSellOfferCard offer={priced} submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get my estimate' }));
    await waitFor(() => expect(screen.getByText(/Request received/)).toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it('a 409 turns into a refresh prompt instead of a dead retry', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, status: 409, body: null });
    render(<CrossSellOfferCard offer={priced} submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get my estimate' }));
    expect(await screen.findByRole('button', { name: /Offer updated/ })).toBeInTheDocument();
  });
});
