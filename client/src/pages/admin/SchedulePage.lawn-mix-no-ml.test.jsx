// @vitest-environment jsdom
//
// Owner ruling (2026-09-27, every service 2026-09-29): nothing a tech sees is
// in mL. A lawn protocol product can be given an mL rate unit (the protocol
// editor accepts any unit, and the plan's mix unit is the catalog rate
// unit), so the lawn mix displays read an mL quantity the way the truck
// measures it (tsp under 1 fl oz, else fl oz) on its own basis. Every other
// unit prints exactly as the plan serves it.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, ProtocolPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const ML_WORD = /\b(ml|millilit(er|re)s?)\b/i;
const reply = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Service Protocol drawer lawn mix', () => {
  const service = {
    id: 'mix-units-visit', customerId: 'mix-units-customer', serviceType: 'Lawn Care',
    customerName: 'Fixture account', lawnType: 'St. Augustine', lawnSqft: 10000,
  };
  function fixture(url) {
    const path = new URL(url, 'http://localhost').pathname;
    if (path.endsWith('/intelligence-bar/quick-actions')) return { actions: [] };
    if (path.includes('/protocols/job-card/')) return { enabled: false };
    if (path.endsWith('/pay-growth/availability')) return { available: false };
    if (path.endsWith('/turf-profile')) return { profile: { track_key: 'A_St_Aug_Sun', lawn_sqft: 10000 } };
    if (path.endsWith('/photos/relevant')) return { photos: [] };
    if (path.endsWith('/seasonal-index')) return { pests: [] };
    if (path.endsWith('/scripts')) return { scripts: [] };
    if (path.endsWith('/equipment')) return { checklists: [] };
    if (path.endsWith('/programs')) return { track: { name: 'Fixture lawn program', notes: [], visits: [] } };
    if (path.endsWith('/lawn-mix')) return {
      month: 'Jul', visit: { visit: 7 }, areaSqft: 10000,
      equipment: { systemName: 'Fixture calibrated rig', carrierGalPer1000: 2 },
      items: [
        { raw: 'Kelp by the job', selected: true, product: { name: 'Job kelp' }, jobMix: { amount: 30, amountUnit: 'ml' }, fullTankMix: { amount: 300, amountUnit: 'ml' } },
        { raw: 'Kelp per gallon', selected: false, product: { name: 'Gallon kelp' }, jobMix: null, fullTankMix: null, plannedMix: { amount: null, amountUnit: 'ml/gal' }, plannedFullTankMix: { amount: null, amountUnit: 'ml/gal' } },
        { raw: 'Base instruction', selected: true, product: { name: 'Liquid potassium' }, jobMix: { amount: 30, amountUnit: 'fl_oz' }, fullTankMix: { amount: 60, amountUnit: 'fl_oz' } },
      ],
    };
    throw new Error(`Unexpected request: ${path}`);
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url) => reply(fixture(url))));
    vi.stubGlobal('scrollTo', vi.fn());
  });

  it('reads an mL quantity in fl oz on its own basis and leaves every other unit as served', async () => {
    await act(async () => { render(<ProtocolPanel service={service} onClose={() => {}} />); });
    const job = within(await screen.findByRole('group', { name: 'Job kelp' }));
    // 30 mL is 1.01 fl oz; 300 mL is 10.14 fl oz.
    expect(job.getByText('1.01 fl oz')).toBeTruthy();
    expect(job.getByText('10.14 fl oz/tank')).toBeTruthy();
    const gallon = within(screen.getByRole('group', { name: 'Gallon kelp' }));
    expect(gallon.getByText('— fl oz/gal')).toBeTruthy();
    expect(gallon.getByText('— fl oz/gal/tank')).toBeTruthy();
    const potassium = within(screen.getByRole('group', { name: 'Liquid potassium' }));
    expect(potassium.getByText('30 fl_oz')).toBeTruthy();
    expect(potassium.getByText('60 fl_oz/tank')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Service Protocol' }).textContent).not.toMatch(ML_WORD);
  });
});

describe('Complete Service lawn protocol mix (WaveGuard)', () => {
  const service = {
    id: 'mix-units-lawn-visit', customerId: 'mix-units-customer', customerName: 'Synthetic Customer',
    serviceType: 'Every 6 Weeks Lawn Care Service', status: 'on_site', scheduledDate: '2099-01-01', estimatedPrice: 90,
    waveguardTier: 'Silver', completionProfile: { serviceKey: 'lawn', requiresProducts: true },
  };
  const plan = {
    protocol: { structured: { window: { title: 'Fixture summer window', goal: 'Fixture goal', defaultCarrierGalPer1000: 1 } } },
    mixCalculator: {
      carrierGalPer1000: 1,
      items: [
        { product: { id: 'mix-kelp', name: 'Fixture kelp' }, mix: { ratePer1000: 5, rateUnit: 'ml' } },
        { product: { id: 'mix-potassium', name: 'Fixture potassium' }, mix: { ratePer1000: 3, rateUnit: 'fl_oz' } },
      ],
    },
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn((url) => reply(String(url).includes(`/treatment-plans/${service.id}`)
      ? { plan }
      : { customer: {}, actions: [], available: false })));
  });

  it('reads an mL tank amount in fl oz and leaves a fl oz amount as served', async () => {
    await act(async () => {
      render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn()} />);
    });
    await waitFor(() => expect(screen.getByText('Fixture summer window')).toBeTruthy());
    // 5 mL per 1,000 sq ft x 110 gal at 1 gal/1K is 550 mL: 18.6 fl oz.
    expect(screen.getByText('18.6 fl oz')).toBeTruthy();
    expect(screen.getByText('330 fl_oz')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(ML_WORD);
  });
});
