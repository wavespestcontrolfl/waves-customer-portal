// @vitest-environment jsdom
//
// The Complete Service form on a regular pest visit (owner 2026-10-04): it
// opens on "customer home - spoke with them", has no Protocol actions field
// and no visit-level Areas treated field, and each product row offers the
// whole pest area list. The areas sent at completion are the rows' own areas.
// A non-pest line keeps both fields.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AREAS_BY_SERVICE, CompletionPanel, areasFromProductRows } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const pestCatalog = [
  { id: 'p1', name: 'Taurus SC', category: 'Insecticide' },
  { id: 'p2', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'p3', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' },
];

const regularPest = (overrides = {}) => ({
  id: 'pest-trim-visit',
  customerId: 'pest-trim-customer',
  customerName: 'Synthetic Pest Customer',
  serviceType: 'General Pest Control (Quarterly)',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 120,
  completionProfile: { serviceKey: 'pest_general_quarterly', requiresProducts: true },
  ...overrides,
});
// A bare "Pest Control" visit is not a regular pest visit: the house mix
// never seeds on it, so it keeps the full form's fields.
const bareLine = () => regularPest({
  id: 'pest-trim-bare', serviceType: 'Pest Control', completionProfile: undefined,
});

const draftKey = (service) => `waves_completion_draft_${service.id}`;
const submitButton = () => screen.getAllByRole('button', { name: /^Complete (& Send (Recap|Invoice)|Service)/i }).at(-1);
// A perimeter spray row needs its linear feet before the visit completes.
const fillLinearFeet = () => screen.getAllByPlaceholderText('Linear ft')
  .forEach((input) => fireEvent.change(input, { target: { value: '120' } }));
const areasFields = () => document.querySelectorAll('[id^="cp-areas-treated-"]');

async function mount(service, { onSubmit = vi.fn().mockResolvedValue({}) } = {}) {
  await act(async () => {
    render(<CompletionPanel service={service} products={pestCatalog} onClose={() => {}} onSubmit={onSubmit} />);
  });
  return onSubmit;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/default-products')
      ? { source: 'none', products: [], unresolved: [] }
      : { customer: {}, actions: [], available: false }),
  })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('areasFromProductRows', () => {
  const list = ['Perimeter', 'Garage', 'Kitchen', 'Yard'];
  it('is the union of the rows\' areas in the list\'s order, each once', () => {
    expect(areasFromProductRows([
      { applicationArea: 'Yard, Kitchen' },
      { applicationArea: 'Perimeter, Kitchen' },
      { applicationArea: '' },
      {},
    ], list)).toEqual(['Perimeter', 'Kitchen', 'Yard']);
  });
  it('keeps an area that is not on the list after the listed ones', () => {
    expect(areasFromProductRows([{ applicationArea: 'Old shed, Garage' }, { applicationArea: 'Old shed' }], list))
      .toEqual(['Garage', 'Old shed']);
  });
  it('is empty with no rows or no areas', () => {
    expect(areasFromProductRows([], list)).toEqual([]);
    expect(areasFromProductRows([{ applicationArea: '' }], list)).toEqual([]);
  });
});

describe.each([['desktop', 1024], ['phone', 390]])('the Complete Service form, %s layout', (_layout, width) => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  });

  it('opens on customer home, spoke with them', async () => {
    await mount(regularPest());
    const select = document.querySelector('[name="customerInteraction"]');
    expect(select.value).toBe('tech_home_spoke_with_them');
    expect(within(select).getByRole('option', { name: 'Customer home — spoke with them', selected: true })).toBeTruthy();
  });

  it('shows no Protocol actions and no Areas treated on a regular pest visit', async () => {
    await mount(regularPest());
    await screen.findByText('Taurus SC');
    expect(screen.queryByLabelText('Add protocol action')).toBeNull();
    expect(screen.queryByText(/protocol actions/i)).toBeNull();
    expect(areasFields()).toHaveLength(0);
  });

  it('keeps both fields on a line that is not a regular pest visit', async () => {
    await mount(bareLine());
    expect(await screen.findByLabelText('Add protocol action')).toBeTruthy();
    expect(areasFields()).toHaveLength(1);
  });

  it('keeps both fields on a specialty pest line (cockroach)', async () => {
    await mount(regularPest({
      id: 'pest-trim-roach', serviceType: 'Cockroach Control',
      completionProfile: { serviceKey: 'cockroach_control', requiresProducts: true },
    }));
    expect(await screen.findByLabelText('Add protocol action')).toBeTruthy();
    expect(areasFields()).toHaveLength(1);
  });

  it('offers the whole pest list on each product row and sends the rows\' areas as the visit\'s', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    const pickers = await screen.findAllByText('Treatment areas');
    expect(pickers).toHaveLength(3);
    for (const area of AREAS_BY_SERVICE.pest) {
      expect(within(pickers[0].parentElement).getByRole('button', { name: area })).toBeTruthy();
    }
    // Row two picks Yard then Garage, row one picks Kitchen; the visit's
    // areas come out in the list's order whatever the order of the taps.
    fireEvent.click(within(pickers[1].parentElement).getByRole('button', { name: 'Yard' }));
    fireEvent.click(within(pickers[1].parentElement).getByRole('button', { name: 'Garage' }));
    fireEvent.click(within(pickers[0].parentElement).getByRole('button', { name: 'Kitchen' }));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.areasServiced).toEqual(['Garage', 'Kitchen', 'Yard']);
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Kitchen', 'Garage, Yard', null]);
    expect(body.customerInteraction).toBe('tech_home_spoke_with_them');
    expect(body.protocolActionsCompleted).toEqual([]);
  });

  it('sends no areas when no row names one, and gives a row no other row\'s area', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].areasServiced).toEqual([]);

    cleanup();
    localStorage.clear();
    const second = await mount(regularPest());
    const pickers = await screen.findAllByText('Treatment areas');
    fireEvent.click(within(pickers[0].parentElement).getByRole('button', { name: 'Perimeter' }));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    const body = second.mock.calls[0][1];
    expect(body.areasServiced).toEqual(['Perimeter']);
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Perimeter', null, null]);
  });

  it('an untouched form mints no draft', async () => {
    vi.useFakeTimers();
    try {
      const service = regularPest();
      await mount(service);
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(localStorage.getItem(draftKey(service))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restoring a saved draft on a regular pest visit', () => {
  const restore = async (service, saved) => {
    localStorage.setItem(draftKey(service), JSON.stringify({ serviceId: service.id, ...saved }));
    await mount(service);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  };

  it('keeps the draft\'s own customer answer', async () => {
    await restore(regularPest(), { notes: 'Saved note', customerInteraction: 'not_home_full_access' });
    expect(document.querySelector('[name="customerInteraction"]').value).toBe('not_home_full_access');
  });

  it('a draft saved with no answer opens on the default', async () => {
    await restore(regularPest(), { notes: 'Saved note', customerInteraction: '' });
    expect(document.querySelector('[name="customerInteraction"]').value).toBe('tech_home_spoke_with_them');
  });

  it('hands visit-level areas from an old draft to the rows that name none, then hides them', async () => {
    const service = regularPest();
    const row = (id, name, applicationArea) => ({
      productId: id, name, rate: '', rateUnit: '', totalAmount: 4, amountUnit: 'fl_oz',
      applicationMethod: 'perimeter_spray', applicationArea, areaUnit: 'linear_ft', targets: [],
    });
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: 'Saved note',
      areasServiced: ['Kitchen', 'Perimeter'],
      selectedProducts: [row('p1', 'Taurus SC', ''), row('p2', 'Atticus Talak 7.9 F', 'Yard')],
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Taurus SC');
    expect(areasFields()).toHaveLength(0);
    await waitFor(() => expect(screen.getAllByText('Treatment areas')).toHaveLength(2));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The first row took the ticked areas, in the list's order; the second kept its own.
    const body = onSubmit.mock.calls[0][1];
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Perimeter, Kitchen', 'Yard']);
    expect(body.areasServiced).toEqual(['Perimeter', 'Kitchen', 'Yard']);
  });

  it('keeps a protocol action the draft already carries and still sends it', async () => {
    const service = regularPest();
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: '[Protocol] Perimeter spray',
      selectedProtocolActionLabels: ['Perimeter spray'],
      actionScopeByLabel: { 'Perimeter spray': { scope: 'exterior', treatmentApplied: true } },
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    expect(screen.queryByLabelText('Add protocol action')).toBeNull();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].protocolActionsCompleted).toEqual(['Perimeter spray']);
  });
});
