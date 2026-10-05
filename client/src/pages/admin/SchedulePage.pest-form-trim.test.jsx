// @vitest-environment jsdom
//
// The Complete Service form on a regular pest visit (owner 2026-10-04): it
// opens on "customer home - spoke with them", has no Protocol actions field
// and no visit-level Areas treated field, and each product row offers the
// whole pest area list. The areas sent at completion are the rows' own areas.
// A non-pest line keeps both fields. One box stays (owner 2026-10-05):
// "Swept eaves and webs" records the pest protocol's sweep action.
// Seeded default rows start on an area (owner 2026-10-05): Perimeter for an
// exterior method; other methods start empty.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AREAS_BY_SERVICE, CompletionPanel, areasFromProductRows, pestRowDefaultArea, withPestRowDefaultArea,
} from './SchedulePage';

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

const SWEEP_LABEL = 'Swept eaves, window frames, door frames, and lanai';
const sweepBox = () => screen.queryByRole('checkbox', { name: 'Swept eaves and webs' });

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

describe('pestRowDefaultArea', () => {
  it('maps an exterior method to Perimeter', () => {
    for (const method of ['perimeter_spray', 'broadcast_spray', 'granular_broadcast', 'Perimeter band']) {
      expect(pestRowDefaultArea(method)).toBe('Perimeter');
    }
  });
  // Interior defaults only seed on typed visits (cockroach), which keep their
  // own area field (Codex P2 #5978).
  it('leaves interior, unknown and missing methods empty', () => {
    for (const method of ['spot_treatment', 'bait_placement', 'Gel bait', 'soil_drench', 'station_check', 'fog_ulv', '', undefined]) {
      expect(pestRowDefaultArea(method)).toBe('');
    }
  });
  it('only ever offers areas on the pest list', () => {
    expect(AREAS_BY_SERVICE.pest).toContain(pestRowDefaultArea('perimeter_spray'));
  });
  it('fills an empty area only, and marks it as a default', () => {
    expect(withPestRowDefaultArea({ applicationMethod: 'perimeter_spray', applicationArea: '' }))
      .toEqual({ applicationMethod: 'perimeter_spray', applicationArea: 'Perimeter', applicationAreaDefault: true });
    const own = { applicationMethod: 'perimeter_spray', applicationArea: 'Garage' };
    expect(withPestRowDefaultArea(own)).toBe(own);
    const interior = { applicationMethod: 'spot_treatment', applicationArea: '' };
    expect(withPestRowDefaultArea(interior)).toBe(interior);
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

  it('shows one unchecked "Swept eaves and webs" box on a regular pest visit', async () => {
    await mount(regularPest());
    await screen.findByText('Taurus SC');
    expect(screen.getAllByRole('checkbox', { name: 'Swept eaves and webs' })).toHaveLength(1);
    expect(sweepBox().checked).toBe(false);
  });

  it('shows no sweep box on a line that is not a regular pest visit', async () => {
    await mount(bareLine());
    await screen.findByLabelText('Add protocol action');
    expect(sweepBox()).toBeNull();
    cleanup();
    await mount(regularPest({
      id: 'pest-trim-roach', serviceType: 'Cockroach Control',
      completionProfile: { serviceKey: 'cockroach_control', requiresProducts: true },
    }));
    await screen.findByLabelText('Add protocol action');
    expect(sweepBox()).toBeNull();
  });

  it('sends the sweep action with its exterior, no-treatment scope when the box is checked', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    fireEvent.click(sweepBox());
    expect(sweepBox().checked).toBe(true);
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.protocolActionsCompleted).toEqual([SWEEP_LABEL]);
    expect(body.protocolActionScopesCompleted).toEqual([
      { label: SWEEP_LABEL, scope: 'exterior', treatmentApplied: false },
    ]);
    // The notes carry the same marker line the old dropdown wrote.
    expect(body.technicianNotes || body.notes || '').toContain(`[Protocol] ${SWEEP_LABEL}`);
  });

  it('sends no protocol action when the box is left unchecked, or checked and unchecked again', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].protocolActionsCompleted).toEqual([]);
    expect(onSubmit.mock.calls[0][1].protocolActionScopesCompleted).toEqual([]);

    cleanup();
    localStorage.clear();
    const second = await mount(regularPest());
    await screen.findByText('Taurus SC');
    fireEvent.click(sweepBox());
    fireEvent.click(sweepBox());
    expect(sweepBox().checked).toBe(false);
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second.mock.calls[0][1].protocolActionsCompleted).toEqual([]);
    expect(second.mock.calls[0][1].protocolActionScopesCompleted).toEqual([]);
    expect(JSON.stringify(second.mock.calls[0][1])).not.toContain('[Protocol]');
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
    // Every seeded row opens on Perimeter (owner 2026-10-05). Row two adds
    // Yard then Garage, row one adds Kitchen; the visit's areas come out in
    // the list's order whatever the order of the taps.
    fireEvent.click(within(pickers[1].parentElement).getByRole('button', { name: 'Yard' }));
    fireEvent.click(within(pickers[1].parentElement).getByRole('button', { name: 'Garage' }));
    fireEvent.click(within(pickers[0].parentElement).getByRole('button', { name: 'Kitchen' }));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.areasServiced).toEqual(['Perimeter', 'Garage', 'Kitchen', 'Yard']);
    expect(body.products.map((p) => p.applicationArea)).toEqual([
      'Perimeter, Kitchen', 'Perimeter, Garage, Yard', 'Perimeter',
    ]);
    expect(body.customerInteraction).toBe('tech_home_spoke_with_them');
    expect(body.protocolActionsCompleted).toEqual([]);
  });

  // Owner 2026-10-05: the house mix and its surfactant start on Perimeter, so
  // the report's exterior re-entry line has an area without a tap.
  it('opens the Taurus, Talak and LESCO rows on Perimeter and sends it as the visit\'s area', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    // p1 Taurus SC, p2 Atticus Talak 7.9 F, p3 LESCO 90/10 surfactant.
    expect(body.products.map((p) => [p.productId, p.applicationArea])).toEqual([
      ['p1', 'Perimeter'], ['p2', 'Perimeter'], ['p3', 'Perimeter'],
    ]);
    expect(body.areasServiced).toEqual(['Perimeter']);
  });

  // Codex P2 #5978: an untouched default follows the method.
  it('drops the Perimeter default when the tech switches that row to a non-exterior method', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    const methodSelect = [...document.querySelectorAll('select')].find((el) => el.value === 'perimeter_spray');
    expect(methodSelect).toBeTruthy();
    fireEvent.change(methodSelect, { target: { value: 'spot_treatment' } });
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0][1];
    const changed = body.products.find((p) => p.applicationMethod === 'spot_treatment');
    expect(changed.applicationArea ?? null).toBeNull();
  });

  it('restores Perimeter when the tech switches the method away and back without touching the area', async () => {
    const onSubmit = await mount(regularPest());
    await screen.findByText('Taurus SC');
    const methodSelect = [...document.querySelectorAll('select')].find((el) => el.value === 'perimeter_spray');
    fireEvent.change(methodSelect, { target: { value: 'spot_treatment' } });
    fireEvent.change(methodSelect, { target: { value: 'perimeter_spray' } });
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1].products.map((p) => p.applicationArea)).toEqual(['Perimeter', 'Perimeter', 'Perimeter']);
  });

  it('keeps an area the tech changed, and a row the tech cleared stays clear', async () => {
    const onSubmit = await mount(regularPest());
    const pickers = await screen.findAllByText('Treatment areas');
    // Row one: Perimeter off, Yard on. Row two: Perimeter off, nothing else.
    fireEvent.click(within(pickers[0].parentElement).getByRole('button', { name: 'Perimeter' }));
    fireEvent.click(within(pickers[0].parentElement).getByRole('button', { name: 'Yard' }));
    fireEvent.click(within(pickers[1].parentElement).getByRole('button', { name: 'Perimeter' }));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Yard', null, 'Perimeter']);
    expect(body.areasServiced).toEqual(['Perimeter', 'Yard']);

    cleanup();
    localStorage.clear();
    const second = await mount(regularPest());
    const again = await screen.findAllByText('Treatment areas');
    for (const picker of again) {
      fireEvent.click(within(picker.parentElement).getByRole('button', { name: 'Perimeter' }));
    }
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second.mock.calls[0][1].areasServiced).toEqual([]);
    expect(second.mock.calls[0][1].products.map((p) => p.applicationArea)).toEqual([null, null, null]);
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

  // Codex P2 r2 #5889: visit-level ticks never said which product went
  // where, so they go onto one row, not every row with no area.
  it('puts an old draft\'s visit-level areas on one row when several rows name none', async () => {
    const service = regularPest();
    const row = (id, name) => ({
      productId: id, name, rate: '', rateUnit: '', totalAmount: 4, amountUnit: 'fl_oz',
      applicationMethod: 'perimeter_spray', applicationArea: '', areaUnit: 'linear_ft', targets: [],
    });
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: 'Saved note',
      areasServiced: ['Kitchen', 'Garage'],
      selectedProducts: [row('p1', 'Taurus SC'), row('p2', 'Atticus Talak 7.9 F')],
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Taurus SC');
    await waitFor(() => expect(screen.getAllByText('Treatment areas')).toHaveLength(2));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products.map((p) => p.applicationArea || '')).toEqual(['Garage, Kitchen', '']);
    expect(body.areasServiced).toEqual(['Garage', 'Kitchen']);
  });

  // Codex P2 #5889: a ticked area that no row names must not be dropped.
  it('adds an old draft\'s visit-level areas to the first row when every row already names an area', async () => {
    const service = regularPest();
    const row = (id, name, applicationArea) => ({
      productId: id, name, rate: '', rateUnit: '', totalAmount: 4, amountUnit: 'fl_oz',
      applicationMethod: 'perimeter_spray', applicationArea, areaUnit: 'linear_ft', targets: [],
    });
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: 'Saved note',
      areasServiced: ['Kitchen', 'Perimeter', 'Yard'],
      selectedProducts: [row('p1', 'Taurus SC', 'Perimeter'), row('p2', 'Atticus Talak 7.9 F', 'Yard')],
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Taurus SC');
    await waitFor(() => expect(screen.getAllByText('Treatment areas')).toHaveLength(2));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Perimeter, Kitchen', 'Yard']);
    expect(body.areasServiced).toEqual(['Perimeter', 'Kitchen', 'Yard']);
  });

  // Owner 2026-10-05: the prefill is for a freshly seeded row only.
  it('keeps a restored draft\'s own row areas, empty ones included', async () => {
    const service = regularPest();
    const row = (id, name, applicationArea) => ({
      productId: id, name, rate: '', rateUnit: '', totalAmount: 4, amountUnit: 'fl_oz',
      applicationMethod: 'perimeter_spray', applicationArea, areaUnit: 'linear_ft', targets: [],
    });
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: 'Saved note',
      selectedProducts: [row('p1', 'Taurus SC', 'Yard'), row('p2', 'Atticus Talak 7.9 F', '')],
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Taurus SC');
    await waitFor(() => expect(screen.getAllByText('Treatment areas')).toHaveLength(2));
    fillLinearFeet();
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products.map((p) => p.applicationArea)).toEqual(['Yard', null]);
    expect(body.areasServiced).toEqual(['Yard']);
  });

  it('an old draft that carries the sweep opens with the box checked and sends it', async () => {
    const service = regularPest();
    const onSubmit = vi.fn().mockResolvedValue({});
    localStorage.setItem(draftKey(service), JSON.stringify({
      serviceId: service.id,
      notes: `[Protocol] ${SWEEP_LABEL}`,
      selectedProtocolActionLabels: [SWEEP_LABEL],
      actionScopeByLabel: { [SWEEP_LABEL]: { scope: 'exterior', treatmentApplied: false } },
    }));
    await mount(service, { onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(sweepBox().checked).toBe(true));
    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.protocolActionsCompleted).toEqual([SWEEP_LABEL]);
    expect(body.protocolActionScopesCompleted).toEqual([
      { label: SWEEP_LABEL, scope: 'exterior', treatmentApplied: false },
    ]);
  });

  it('a draft saved with the box checked comes back checked, and an unchecked one comes back clear', async () => {
    vi.useFakeTimers();
    const service = regularPest();
    try {
      await mount(service);
      fireEvent.click(sweepBox());
      await act(async () => { vi.advanceTimersByTime(2000); });
    } finally {
      vi.useRealTimers();
    }
    const saved = JSON.parse(localStorage.getItem(draftKey(service)));
    expect(saved.selectedProtocolActionLabels).toEqual([SWEEP_LABEL]);
    expect(saved.actionScopeByLabel[SWEEP_LABEL]).toMatchObject({ scope: 'exterior', treatmentApplied: false });
    cleanup();
    await mount(service);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(sweepBox().checked).toBe(true));
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
