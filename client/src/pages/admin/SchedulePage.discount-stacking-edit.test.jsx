// @vitest-environment jsdom
//
// GATE_DISCOUNT_STACKING (slice 7 of #4405): the Edit appointment modal's
// per-add-on-line discount picker, its compound preview, non-stackable
// group filtering, save-lock, the submit-time freshness guard, and
// VISIT_CHANGED_RETRY handling. Gate-off parity (byte-identical to before
// this slice) is pinned first — every other test builds on top of it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditServiceModal, verifiedLineDiscountCap, lineDiscountSaveBlocked } from './SchedulePage';
import { __resetDiscountStackingCache } from '../../hooks/useDiscountStacking';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
vi.mock('../../components/schedule/useBestTimes', () => ({ useBestTimes: () => ({ bestTimes: [], picked: null, bestInRange: [] }) }));

const MILITARY = {
  id: 'disc-military', name: 'Military Discount', discount_type: 'fixed_amount', amount: 5,
  max_discount_dollars: null, stack_group: null, is_stackable: true,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};
const SILVER = {
  id: 'disc-silver', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10,
  max_discount_dollars: null, stack_group: 'waveguard', is_stackable: false,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};
const GOLD = {
  id: 'disc-gold', name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15,
  max_discount_dollars: null, stack_group: 'waveguard', is_stackable: false,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};
const CUSTOM_DOLLAR = {
  id: 'disc-custom', name: 'Custom Discount', discount_type: 'variable_amount', amount: 0,
  max_discount_dollars: null, stack_group: null, is_stackable: true,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};
const TERMITE_ONLY = {
  id: 'disc-termite', name: 'Termite Special', discount_type: 'fixed_amount', amount: 20,
  max_discount_dollars: null, stack_group: null, is_stackable: true,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
  service_key_filter: 'termite_bond',
};
const DISCOUNTS = [MILITARY, SILVER, GOLD];
const DISCOUNTS_R2 = [...DISCOUNTS, CUSTOM_DOLLAR, TERMITE_ONLY];

const BIG_CREDIT = {
  id: 'disc-bigcredit', name: 'Big Credit', discount_type: 'fixed_amount', amount: 12,
  max_discount_dollars: null, stack_group: null, is_stackable: true,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};
const DISCOUNTS_R3 = [...DISCOUNTS, BIG_CREDIT];

// A row marked under the canonical engine (pricing_provenance.pricing_regime
// === 'discount_stack_v1') — its Military stamp on the mosquito line was
// frozen against a $20 cap that no longer matches the LIVE catalog row
// (SILVER's own max_discount_dollars, used below, stays null/uncapped —
// the frozen-cap test below uses a SEPARATE percentage stamp for that).
const MARKED_PROVENANCE = {
  pricing_regime: 'discount_stack_v1', engine_version: 1,
  caps: { line: null, addons: { 'disc-military': null } },
};

// Small, hand-verified numbers (see the lane report) chosen specifically so
// canonical (compound) fixed-credit REORDERING clamps the line's own $5
// credit down to $2 while additive leaves it at its full $5 — proving the
// two engines are NOT interchangeable, not just a smoke test.
// primary $5 + fert gross $10 = $15 subtotal.
// Compound: BigCredit($12) sorts BEFORE Military($5) by value, pro-rates
//   across both lines (primary share $4, fert share $8), leaving fert only
//   $2 for Military to clamp against → total discount $12+$2=$14 → Total $1.
// Additive: Military($5) resolves first, full, against fert's own $10 →
//   fert remaining $5; BigCredit(12) then clamps to the $10 aggregate left
//   (primary $5 + fert $5) → total discount $5+$10=$15 → Total $0.
function orderingSensitiveService(pricingProvenance) {
  return {
    ...baseService,
    primaryLinePrice: 5,
    estimatedPrice: 10,
    serviceAddons: [
      {
        id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
        serviceCategory: 'mosquito', basePrice: 10, estimatedPrice: 5, discountId: 'disc-military',
        discountName: 'Military Discount', discountType: 'fixed_amount', discountAmount: 5, discountDollars: 5,
        estimatedDuration: 30,
      },
    ],
    pricingProvenance: pricingProvenance ?? null,
  };
}

// A legacy row: the mosquito add-on already carries a STORED Military stamp
// (base_price 60, discount_amount 5, net 55) — exactly mapAddonRow's shape.
// The fertilization add-on carries no discount at all, so its Line discount
// picker renders in "None" state.
const baseService = {
  id: 'fixture-visit', customerId: 'fixture-account', customerName: 'Fixture account',
  serviceType: 'Quarterly Pest', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:00',
  status: 'confirmed', notes: 'Existing note', estimatedPrice: 195, primaryLinePrice: 100,
  serviceAddons: [
    {
      id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
      serviceCategory: 'mosquito', basePrice: 60, estimatedPrice: 55, discountId: 'disc-military',
      discountName: 'Military Discount', discountType: 'fixed_amount', discountAmount: 5, discountDollars: 5,
      estimatedDuration: 30,
    },
    {
      id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert',
      serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20,
    },
  ],
};

function mockFetch({ stackingEnabled, discounts = DISCOUNTS, onUpdateDetails } = {}) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      return { ok: true, json: async () => ({ enabled: stackingEnabled }) };
    }
    if (url.endsWith('/admin/discounts')) {
      return { ok: true, json: async () => discounts };
    }
    if (url.includes('/update-details')) {
      if (onUpdateDetails) return onUpdateDetails(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

function Harness({ onSaved = vi.fn(), service = baseService }) {
  const [open, setOpen] = React.useState(false);
  return <>
    <button onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}>Edit visit</button>
    {open && <EditServiceModal service={service} technicians={[]} onClose={() => setOpen(false)} onSaved={onSaved} />}
  </>;
}

const writes = () => fetch.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');
// This modal's <label>s are visual-only siblings of their control (no
// htmlFor/id pair, no wrapping) — getByLabelText can't associate them.
function labeledControl(text) {
  return screen.getByText(text, { selector: 'label' }).parentElement.querySelector('select, input');
}
const apptDiscountSelect = () => labeledControl('Discount');

beforeEach(() => {
  __resetDiscountStackingCache();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); localStorage.clear(); });

describe('lineDiscountSaveBlocked / verifiedLineDiscountCap', () => {
  it('blocks only when the gate is unconfirmed AND both an appointment pick and a line discount are in play', () => {
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: true, lines: [{ _origDiscountType: 'fixed_amount' }] })).toBe(true);
    expect(lineDiscountSaveBlocked({ known: true, appointmentDiscountSelected: true, lines: [{ _origDiscountType: 'fixed_amount' }] })).toBe(false);
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: false, lines: [{ _origDiscountType: 'fixed_amount' }] })).toBe(false);
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: true, lines: [{}] })).toBe(false);
    // An explicitly REMOVED line discount is no longer "in play" even though
    // _origDiscountType is still on the row.
    expect(lineDiscountSaveBlocked({
      known: false, appointmentDiscountSelected: true,
      lines: [{ _origDiscountType: 'fixed_amount', lineDiscountTouched: true, lineDiscount: null }],
    })).toBe(false);
  });

  it('trusts a stamp\'s own cap only when the catalog row still confirms its type/amount', () => {
    const stamp = { discount_type: 'percentage', amount: 10, id: 'disc-silver' };
    expect(verifiedLineDiscountCap(stamp, { discount_type: 'percentage', amount: 10, max_discount_dollars: 20 }))
      .toMatchObject({ max_discount_dollars: 20 });
    // Catalog amount now disagrees (preset edited since) — cap withheld, stamp unchanged.
    expect(verifiedLineDiscountCap(stamp, { discount_type: 'percentage', amount: 15, max_discount_dollars: 20 }))
      .toBe(stamp);
    // No catalog row loaded yet — stamp unchanged.
    expect(verifiedLineDiscountCap(stamp, null)).toBe(stamp);
    expect(verifiedLineDiscountCap(null, {})).toBeNull();
  });
});

it('gate off: no Line discount control renders, and a notes-only save posts the exact pre-lane payload', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: false }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('$195.00').length).toBeGreaterThan(0));
  expect(screen.queryByText('Line discount')).not.toBeInTheDocument();
  const notes = screen.getByDisplayValue('Existing note');
  fireEvent.change(notes, { target: { value: 'Updated note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.addons).toMatchObject([
    { serviceId: 'svc-mosquito', basePrice: 60, discountType: 'fixed_amount', discountAmount: 5, discountId: 'disc-military', discountName: 'Military Discount' },
    { serviceId: 'svc-fert', price: 40 },
  ]);
});

it('gate on but untouched: the same notes-only save posts the identical addons payload (parity)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Line discount').length).toBeGreaterThan(0));
  const notes = screen.getByDisplayValue('Existing note');
  fireEvent.change(notes, { target: { value: 'Updated note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.addons).toMatchObject([
    { serviceId: 'svc-mosquito', basePrice: 60, discountType: 'fixed_amount', discountAmount: 5, discountId: 'disc-military', discountName: 'Military Discount' },
    { serviceId: 'svc-fert', price: 40 },
  ]);
});

it('gate on: picking a fresh line discount previews compound math and posts the gross+slot', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  // Silver: 10% of the $40 fertilization line = $4.00, shown as its own row.
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  expect(screen.getByText('($4.00)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const fertLine = body.addons.find((a) => a.serviceId === 'svc-fert');
  expect(fertLine).toMatchObject({ basePrice: 40, discountType: 'percentage', discountAmount: 10, discountId: 'disc-silver', discountName: 'WaveGuard Silver' });
});

it('gate on: a non-stackable tier chosen on a line hides its WHOLE group from the appointment select (it spans every line, including that one)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // The appointment-level slot reaches every line, including the one that
  // already carries Silver — offering EITHER waveguard tier there would let
  // the operator create exactly the forbidden combination (a line's own
  // tier plus the document-wide slot compounding on that same line).
  const apptOptionNames = [...apptDiscountSelect().options].map((o) => o.textContent);
  expect(apptOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
  expect(apptOptionNames.some((t) => t.includes('WaveGuard Silver'))).toBe(false);
  expect(apptOptionNames.some((t) => t.includes('Military Discount'))).toBe(true);
});

it('gate on: Remove on an ALREADY-STAMPED line restores its true gross and posts a clean, discount-free line (Codex pre-push audit P1, round 1)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // The mosquito line's Price box shows its seeded NET ($55, base $60 minus
  // the stored $5 Military credit) until its discount control is touched.
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  const priceInputs = screen.getAllByPlaceholderText('0.00');
  const mosquitoPriceBefore = priceInputs.find((i) => Number(i.value) === 55);
  expect(mosquitoPriceBefore).toBeTruthy();
  const removeButtons = screen.getAllByRole('button', { name: 'Remove line discount' });
  fireEvent.click(removeButtons[0]); // mosquito is the first (and, before this click, only) chosen display
  expect(screen.queryByText('Military Discount', { selector: 'div' })).not.toBeInTheDocument();
  // Price snapped to the true gross ($60), not left at the discounted net.
  expect(priceInputs.find((i) => Number(i.value) === 60)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const mosquitoLine = body.addons.find((a) => a.serviceId === 'svc-mosquito');
  // Full gross, no discount fields at all — never the stale $55 masquerading
  // as a full price with the discount's own record erased.
  expect(mosquitoLine).toMatchObject({ price: 60 });
  expect(mosquitoLine.discountType).toBeUndefined();
  expect(mosquitoLine.basePrice).toBeUndefined();
});

it('gate on: the same non-stackable tier stays offered on a DIFFERENT line (one tier on two lines is fine)', async () => {
  const twoUndiscountedLines = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
      { id: 'addon-3', serviceId: 'svc-tree', serviceName: 'Tree & Shrub', serviceKey: 'tree_shrub', serviceCategory: 'tree_shrub', basePrice: 30, estimatedPrice: 30, estimatedDuration: 15 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness service={twoUndiscountedLines} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  const treePicker = screen.getByRole('combobox', { name: 'Line discount for Tree & Shrub' });
  const treeOptionNames = [...treePicker.options].map((o) => o.textContent);
  expect(treeOptionNames.some((t) => t.includes('WaveGuard Silver'))).toBe(true);
  expect(treeOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
});

it('gate on: Remove clears a fresh line pick back to the picker and drops its row from the totals', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // Both the fresh Silver pick AND the mosquito line's own frozen Military
  // stamp render a Remove control; the fert line (added second) is last.
  const removeButtons = screen.getAllByRole('button', { name: 'Remove line discount' });
  fireEvent.click(removeButtons[removeButtons.length - 1]);
  // Only the appointment select's own option text may still say "WaveGuard
  // Silver" (the catalog row itself is untouched) — the per-line display box
  // and the totals summary row are both gone.
  expect(screen.queryByText('WaveGuard Silver', { selector: 'div' })).not.toBeInTheDocument();
  expect(screen.queryByText('WaveGuard Silver', { selector: 'span' })).not.toBeInTheDocument();
  expect(await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' })).toBeInTheDocument();
});

it('retryable gate availability: an unconfirmed probe with an interacting appointment+line discount refuses the submit', async () => {
  let resolveStacking;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return new Promise((resolve) => { resolveStacking = resolve; });
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // The mosquito line's stored Military stamp already counts as a line
  // discount in play; select an appointment-level discount to create the
  // ambiguous (unconfirmed gate) interaction.
  await waitFor(() => expect(apptDiscountSelect()).toBeInTheDocument());
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '10' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled());
  expect(screen.getByText(/Could not confirm how multiple discounts combine/)).toBeInTheDocument();
  await act(async () => { resolveStacking({ ok: true, json: async () => ({ enabled: true }) }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
});

it('VISIT_CHANGED_RETRY: the save is refused with a clear message and nothing silently overwrites', async () => {
  vi.stubGlobal('fetch', mockFetch({
    stackingEnabled: true,
    onUpdateDetails: async () => ({
      ok: false, status: 409, json: async () => ({ code: 'VISIT_CHANGED_RETRY', error: 'stale' }),
    }),
  }));
  const onSaved = vi.fn();
  render(<Harness onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const notes = await screen.findByDisplayValue('Existing note');
  fireEvent.change(notes, { target: { value: 'Updated note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/changed since it opened/);
  expect(onSaved).not.toHaveBeenCalled();
  // The modal stays open with the edit intact — nothing was silently lost.
  expect(screen.getByDisplayValue('Updated note')).toBeInTheDocument();
});

it('save-lock: a double click while a discounted save is in flight posts exactly once', async () => {
  let resolveSave;
  vi.stubGlobal('fetch', mockFetch({
    stackingEnabled: true,
    onUpdateDetails: async () => new Promise((resolve) => { resolveSave = () => resolve({ ok: true, json: async () => ({}) }); }),
  }));
  const onSaved = vi.fn();
  render(<Harness onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  fireEvent.click(save);
  fireEvent.click(save);
  await act(async () => { resolveSave(); });
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(writes().filter(([url]) => url.includes('/update-details'))).toHaveLength(1);
});

// ---------------------------------------------------------------------
// Codex pre-push audit round 2 on PR #4657 (github.com/wavespestcontrolfl/
// waves-customer-portal/pull/4657, /tmp/t4657-r1.txt): 7 P1 + 2 P2 findings
// against 10a1ff4aaf. This section covers every finding fixed in this
// round; #2186 (server-side line eligibility), #3293/#3295 (stored
// appointment discount / legacy-vs-marked provenance, both needing GET/PUT
// fields the server doesn't expose) are blocked by file ownership — see
// the PR's own report for why.
// ---------------------------------------------------------------------

it('P1 (:2306): editing Price on an already-stamped line without touching its discount control drops the stale discount from the preview and posts the flat typed price', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  // The mosquito line's Price box shows its seeded NET ($55) — edit it to
  // $70 WITHOUT touching the Line discount control (no Remove, no picker).
  const priceInputs = screen.getAllByPlaceholderText('0.00');
  const mosquitoPrice = priceInputs.find((i) => Number(i.value) === 55);
  fireEvent.change(mosquitoPrice, { target: { value: '70' } });
  // The stale discount must be gone from the preview — never $55-with-
  // discount shown while $70 is what will actually save.
  await waitFor(() => expect(screen.queryByText('Military Discount', { selector: 'div' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const mosquitoLine = body.addons.find((a) => a.serviceId === 'svc-mosquito');
  expect(mosquitoLine).toMatchObject({ price: 70 });
  expect(mosquitoLine.discountType).toBeUndefined();
});

it('P1 (:2803): a line discount picked while the gate is on is dropped from preview AND save once the gate closes mid-edit', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // The gate closes — a later poll reports off. Force a live re-probe the
  // same way an already-mounted tab does (useDiscountStacking.js's own
  // visibilitychange listener), rather than waiting a real 60s TTL window.
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  // The control and its preview row disappear once the gate reads off —
  // React state still holds the hidden pick underneath.
  await waitFor(() => expect(screen.queryByText('WaveGuard Silver')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Line discount for Quarterly Fertilization' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const fertLine = body.addons.find((a) => a.serviceId === 'svc-fert');
  // The hidden pick must never reach the wire once the operator can no
  // longer see it in the preview.
  expect(fertLine.discountType).toBeUndefined();
  expect(fertLine.basePrice).toBeUndefined();
});

it('P2 (:2334): a non-finite custom-dollar prompt (e.g. 1e309) is rejected, not silently accepted as "covers everything"', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R2 }));
  vi.spyOn(window, 'prompt').mockReturnValue('1e309');
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-custom' } });
  // Rejected: the picker stays in "None" state, no chosen-discount display.
  expect(screen.queryByText('Custom Discount')).not.toBeInTheDocument();
  expect(await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' })).toBeInTheDocument();
});

it('P1 (:3689) + P2 (:3730): line-discount amounts use neutral (not alert-red) color, and guidance text meets the 14px floor', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  const detailEls = screen.getAllByText((_, el) => el?.textContent?.includes('$5.00') && el.tagName === 'DIV');
  for (const el of detailEls) expect(el.style.color).not.toBe('#B42318');
  // Guidance note under an unpicked line's select meets the 14px floor.
  const guidance = screen.getByText(/Picking one treats the Price above/);
  expect(guidance.style.fontSize).toBe('14px');
});

it('P1 (:2186, partial): a line-scoped catalog preset only appears on a matching line, not an unrelated one', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R2 }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  const fertOptionNames = [...fertPicker.options].map((o) => o.textContent);
  // Termite Special is scoped to service_key_filter 'termite_bond' — the
  // fertilization line (lawn_fert) must never be offered it.
  expect(fertOptionNames.some((t) => t.includes('Termite Special'))).toBe(false);
  expect(fertOptionNames.some((t) => t.includes('WaveGuard Silver'))).toBe(true);
});

// ---------------------------------------------------------------------
// Coordinator-approved scope extension on PR #4657 (#4654 merged, server/
// routes/admin-schedule.js free): :3293 (hydrate the stored appointment
// discount), :3295 (choose compound-vs-additive by the row's own
// provenance, not the gate alone), :1662 (preview an existing stamp's
// FROZEN cap, never the live catalog), and the new :2380 (a gate-flip
// mid-edit must fully reset a touched line, not just hide it).
// ---------------------------------------------------------------------

function totalText() {
  return screen.getByText('Total').parentElement.querySelector('strong').textContent;
}

it(':3295 — a MARKED row previews the canonical (compound) engine: fixed-credit reordering clamps the line credit to $2, Total $1.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R3 }));
  render(<Harness service={orderingSensitiveService(MARKED_PROVENANCE)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '12' } });
  await waitFor(() => expect(totalText()).toBe('$1.00'));
});

it(':3295 — the SAME numbers on an UNMARKED row preview the additive engine instead: the line credit stays full ($5), Total $0.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R3 }));
  render(<Harness service={orderingSensitiveService(null)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '12' } });
  await waitFor(() => expect(totalText()).toBe('$0.00'));
});

it(':1662 — a MARKED row previews an existing stamped PERCENTAGE line discount at its FROZEN cap, never the live (lower) catalog cap', async () => {
  const frozenUncapped = {
    pricing_regime: 'discount_stack_v1', engine_version: 1,
    caps: { line: null, addons: { 'disc-silver': null } }, // null = frozen UNCAPPED
  };
  const service = {
    ...baseService,
    pricingProvenance: frozenUncapped,
    serviceAddons: [
      {
        id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
        serviceCategory: 'mosquito', basePrice: 100, estimatedPrice: 90, discountId: 'disc-silver',
        discountName: 'WaveGuard Silver', discountType: 'percentage', discountAmount: 10, discountDollars: 10,
        estimatedDuration: 30,
      },
    ],
  };
  // The LIVE catalog cap ($5) would wrongly clamp a 10%-of-$100 ($10) line
  // discount down to $5 if the preview trusted it instead of the frozen
  // (uncapped) snapshot above.
  const discountsWithLiveCap = DISCOUNTS.map((d) => (
    d.id === 'disc-silver' ? { ...d, max_discount_dollars: 5 } : d
  ));
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: discountsWithLiveCap }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // $10.00 off (frozen, uncapped) — never $5.00 (the live catalog cap).
  await waitFor(() => expect(screen.getByText(/10%.*\$10\.00/)).toBeInTheDocument());
});

it(':3293 — the row\'s STORED appointment discount (never touched this session) is included in the compound preview and the line picker\'s group-conflict filtering', async () => {
  const service = {
    ...baseService,
    discountType: 'percentage', discountAmount: 10, discountId: 'disc-silver', discountMaxDollars: null,
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // The appointment Discount control itself is still untouched (shows "None").
  await waitFor(() => expect(apptDiscountSelect().value).toBe(''));
  // Its stored 10% already reaches the untouched primary+addon lines, so
  // the Total must already be lower than the raw subtotal even though the
  // operator picked nothing this session.
  await waitFor(() => expect(totalText()).not.toBe('$195.00'));
  // Gold shares Silver's waveguard group — hidden from the fert line's
  // picker because the STORED (invisible-until-now) Silver already holds it.
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  const fertOptionNames = [...fertPicker.options].map((o) => o.textContent);
  expect(fertOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
});

it('P1 (:2380) — a gate flip after SWAPPING an already-stamped line\'s discount restores the ORIGINAL stamp, not a flat erasure', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // Swap the mosquito line's stamped Military credit for a fresh Silver pick.
  const removeButtons = await screen.findAllByRole('button', { name: 'Remove line discount' });
  fireEvent.click(removeButtons[0]);
  const mosquitoPicker = screen.getByRole('combobox', { name: 'Line discount for Monthly Mosquito' });
  fireEvent.change(mosquitoPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // Gate closes before Save.
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(screen.queryByText('Line discount')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const mosquitoLine = body.addons.find((a) => a.serviceId === 'svc-mosquito');
  // The ORIGINAL Military stamp round-trips verbatim — never a flat $60
  // (the gross, with the discount silently dropped), and never Silver
  // (the swap the gate never confirmed).
  expect(mosquitoLine).toMatchObject({
    basePrice: 60, discountType: 'fixed_amount', discountAmount: 5, discountId: 'disc-military',
  });
});
