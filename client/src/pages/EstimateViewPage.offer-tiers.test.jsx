// @vitest-environment jsdom
// Good / Better / Best on a pest + lawn estimate: the picker is a view over
// the service opt-out rail. These tests pin the page wiring — the picker
// replaces the one-time toggle, a tile move runs the rail's dry run and then
// its commit (bound to the dry run's previewBasis), and a payload without an
// offerTiers block renders exactly as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { selectedOfferTierKey } from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'offer-tiers-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const frequency = (key, annual) => ({
  key, label: 'Quarterly', monthly: Math.round(annual / 12), annual,
  included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
});

const section = (key, label, isPest, overrides = {}) => ({
  key, label, isRecurring: true, isPest, frequencies: [frequency('quarterly', 600)], copy: { priceWording: {} }, ...overrides,
});

const TIERS_BEST = {
  state: 'best',
  companionKey: 'lawn_care',
  companionLabel: 'Lawn Care',
  good: { oneTimeTotal: 149 },
  better: { rows: [{ service: 'pest_control', perApplication: 114 }], oneTimeTotal: 99, waveGuardTier: 'Bronze' },
  best: {
    rows: [
      { service: 'pest_control', perApplication: 96.3, visitsPerYear: 4 },
      { service: 'lawn_care', perApplication: 69.3, visitsPerYear: 9 },
    ],
    oneTimeTotal: 0,
    waveGuardTier: 'Silver',
  },
};

function bestPayload({ offerTiers = TIERS_BEST, showOneTimeOption = false } = {}) {
  return {
    ...(offerTiers ? { offerTiers } : {}),
    estimate: {
      customerFirstName: 'Rita', address: '12 Oak Lane', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring',
      isOneTimeOnly: false, showOneTimeOption, billByInvoice: false,
    },
    pricing: {
      services: [
        section('pest_control', 'Pest Control', true, { removable: true }),
        section('lawn_care', 'Lawn Care', false, { removable: true }),
      ],
      askChips: [], defaultServiceMode: 'recurring', renderFlags: {},
      ...(showOneTimeOption ? { anchorOneTimePrice: 149 } : {}),
    },
    serviceOptOut: { removedKeys: [], removedLabels: [] },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
  };
}

function pestOnlyPayload() {
  const base = bestPayload({
    offerTiers: { ...TIERS_BEST, state: 'pest_only' },
    showOneTimeOption: true,
  });
  return {
    ...base,
    pricing: { ...base.pricing, services: [section('pest_control', 'Pest Control', true)] },
    serviceOptOut: { removedKeys: ['lawn_care'], removedLabels: ['Lawn Care'] },
  };
}

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const DRY_QUOTE = {
  dryRun: true,
  previewBasis: 'basis-from-the-dry-run',
  previous: { onetimeTotal: 0 },
  next: { onetimeTotal: 99, waveGuardTier: 'Bronze' },
  disclosures: [
    { code: 'waveguard_tier_change', message: 'Dropping Lawn Care moves your WaveGuard tier from Silver to Bronze.' },
  ],
};

function mountWith({ dataPayloads, putResponder } = {}) {
  const queue = [...dataPayloads];
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'PUT' && /service-opt-out/.test(u)) return putResponder(JSON.parse(opts.body));
    if (/\/data(\?|$)/.test(u)) return json(queue.length > 1 ? queue.shift() : queue[0]);
    return json({});
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  render(<EstimateViewPage />);
  return fetchMock;
}

const optOutCalls = (fetchMock) => fetchMock.mock.calls
  .filter(([, opts]) => opts?.method === 'PUT')
  .map(([url, opts]) => ({ url: String(url), body: JSON.parse(opts.body) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('selectedOfferTierKey', () => {
  it('is null without a block', () => {
    expect(selectedOfferTierKey(null, 'recurring')).toBeNull();
    expect(selectedOfferTierKey(undefined, 'one_time')).toBeNull();
  });
  it('is best whenever the block is in the best state, whatever the mode', () => {
    expect(selectedOfferTierKey({ state: 'best' }, 'recurring')).toBe('best');
    expect(selectedOfferTierKey({ state: 'best' }, 'one_time')).toBe('best');
  });
  it('is better or good on a pest-only row by the page mode', () => {
    expect(selectedOfferTierKey({ state: 'pest_only' }, 'recurring')).toBe('better');
    expect(selectedOfferTierKey({ state: 'pest_only' }, 'one_time')).toBe('good');
  });
});

describe('EstimateViewPage with offer tiers', () => {
  it('renders the picker and not the one-time toggle', async () => {
    mountWith({ dataPayloads: [bestPayload({ showOneTimeOption: true })], putResponder: () => json({}) });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Pest \+ lawn care/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'One-Time Pest Control' })).not.toBeInTheDocument();
  });

  it('does not offer the companion its own remove control while the picker owns it', async () => {
    mountWith({ dataPayloads: [bestPayload()], putResponder: () => json({}) });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    expect(screen.queryByRole('button', { name: "I don't want Lawn Care" })).not.toBeInTheDocument();
    // Every other service keeps its control.
    expect(screen.getByRole('button', { name: "I don't want Pest Control" })).toBeInTheDocument();
  });

  it('Better in the best state runs the rail dry run, shows its disclosures, then commits with its previewBasis', async () => {
    const reloaded = pestOnlyPayload();
    const fetchMock = mountWith({
      dataPayloads: [bestPayload(), reloaded],
      putResponder: (body) => (body.dryRun ? json(DRY_QUOTE) : json({ ok: true })),
    });
    await screen.findByRole('radiogroup', { name: 'Plan options' });

    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    expect(await screen.findByText('Switch to Pest control plan?')).toBeInTheDocument();
    expect(screen.getByText(/moves your WaveGuard tier from Silver to Bronze/)).toBeInTheDocument();
    expect(optOutCalls(fetchMock)).toEqual([
      expect.objectContaining({ body: { serviceKey: 'lawn_care', included: false, dryRun: true } }),
    ]);
    expect(optOutCalls(fetchMock)[0].url).toMatch(/\/estimates\/offer-tiers-token\/service-opt-out$/);

    fireEvent.click(screen.getByRole('button', { name: 'Switch my plan' }));
    await waitFor(() => expect(optOutCalls(fetchMock)).toHaveLength(2));
    expect(optOutCalls(fetchMock)[1].body).toEqual({
      serviceKey: 'lawn_care', included: false, previewBasis: 'basis-from-the-dry-run',
    });
    // The reload lands the pest-only state: Better is now the selected tile.
    await waitFor(() => expect(screen.getByRole('radio', { name: /Pest control plan/ })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByText('Switch to Pest control plan?')).not.toBeInTheDocument();
  });

  it('Good in the best state lands on the one-time mode after the rail reload', async () => {
    const fetchMock = mountWith({
      dataPayloads: [bestPayload(), pestOnlyPayload()],
      putResponder: (body) => (body.dryRun ? json(DRY_QUOTE) : json({ ok: true })),
    });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    fireEvent.click(screen.getByRole('radio', { name: /One-time visit/ }));
    await screen.findByText('Switch to One-time visit?');
    fireEvent.click(screen.getByRole('button', { name: 'Switch my plan' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /One-time visit/ })).toHaveAttribute('aria-checked', 'true'));
    expect(optOutCalls(fetchMock)[1].body.previewBasis).toBe('basis-from-the-dry-run');
  });

  it('Keep what I have closes the confirm without writing', async () => {
    const fetchMock = mountWith({
      dataPayloads: [bestPayload()],
      putResponder: () => json(DRY_QUOTE),
    });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    await screen.findByText('Switch to Pest control plan?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep what I have' }));
    await waitFor(() => expect(screen.queryByText('Switch to Pest control plan?')).not.toBeInTheDocument());
    expect(optOutCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Pest \+ lawn care/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('Good <-> Better on a pest-only row is only the one-time mode: no rail call', async () => {
    const fetchMock = mountWith({ dataPayloads: [pestOnlyPayload()], putResponder: () => json({}) });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    expect(screen.getByRole('radio', { name: /Pest control plan/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /One-time visit/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /One-time visit/ })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Pest control plan/ })).toHaveAttribute('aria-checked', 'true'));
    expect(optOutCalls(fetchMock)).toHaveLength(0);
  });

  it('Best on a pest-only row runs the rail restore preview and commit', async () => {
    const fetchMock = mountWith({
      dataPayloads: [pestOnlyPayload(), bestPayload()],
      putResponder: (body) => (body.dryRun
        ? json({ ...DRY_QUOTE, disclosures: [{ code: 'restored_per_application', message: 'Lawn Care comes back at $69.30 per application.' }] })
        : json({ ok: true })),
    });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    // The page's own "add it back" card is the picker's job now.
    expect(screen.queryByText('Lawn Care removed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add it back' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Pest \+ lawn care/ }));
    await screen.findByText('Switch to Pest + lawn care?');
    expect(screen.getByText(/comes back at \$69\.30 per application/)).toBeInTheDocument();
    expect(optOutCalls(fetchMock)[0].body).toEqual({ serviceKey: 'lawn_care', included: true, dryRun: true });
    fireEvent.click(screen.getByRole('button', { name: 'Switch my plan' }));
    await waitFor(() => expect(optOutCalls(fetchMock)).toHaveLength(2));
    expect(optOutCalls(fetchMock)[1].body).toEqual({
      serviceKey: 'lawn_care', included: true, previewBasis: 'basis-from-the-dry-run',
    });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Pest \+ lawn care/ })).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows the rail error and clears the pending move when the dry run fails', async () => {
    mountWith({
      dataPayloads: [bestPayload()],
      putResponder: () => json({ error: 'service_not_removable' }, false, 409),
    });
    await screen.findByRole('radiogroup', { name: 'Plan options' });
    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    await screen.findByText(/can't be removed online/);
    expect(screen.queryByRole('button', { name: 'Switch my plan' })).not.toBeInTheDocument();
    for (const radio of within(screen.getByRole('radiogroup', { name: 'Plan options' })).getAllByRole('radio')) {
      expect(radio).not.toBeDisabled();
    }
  });
});

describe('EstimateViewPage without offer tiers (regression guard)', () => {
  it('renders the one-time toggle and no picker exactly as before', async () => {
    mountWith({
      dataPayloads: [bestPayload({ offerTiers: null, showOneTimeOption: true })],
      putResponder: () => json({}),
    });
    await screen.findByRole('button', { name: 'One-Time Pest Control' });
    expect(screen.queryByRole('radiogroup', { name: 'Plan options' })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose your plan')).not.toBeInTheDocument();
    // The companion keeps its own removal control.
    expect(screen.getByRole('button', { name: "I don't want Lawn Care" })).toBeInTheDocument();
  });
});
