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
import { EditServiceModal, lineDiscountSaveBlocked } from './SchedulePage';
import { __resetDiscountStackingCache } from '../../hooks/useDiscountStacking';
import { stackVisitDiscounts } from '../../lib/discountStack';

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

// Structural round 3 on #4657: the component now sources EVERY money
// figure from POST .../update-details/preview — these tests drive it
// through a test-only "fake server" (computeMockPreview) built on the SAME
// lib/discountStack.js math the real server mirrors, rather than each test
// hand-asserting a client-computed number the component no longer produces.
// Mirrors the shape (not the full nuance) of
// computeUpdateDetailsFinancialPlan: resolves a fresh vs. unchanged addon
// pick by comparing against the fixture's own stored serviceAddons, prefers
// a MARKED row's frozen cap (pricingProvenance.caps), and preserves an
// UNMARKED unchanged stamp's stored dollars verbatim — the same three
// rules the server itself applies.
function computeMockPreview(body, service, discounts) {
  const discountById = new Map(discounts.map((d) => [d.id, d]));
  const compound = service.pricingProvenance?.pricing_regime === 'discount_stack_v1';
  const resolveFreshDiscount = (type, amount, id) => {
    if (!type || amount == null || amount === '') return null;
    const catalogRow = id ? discountById.get(id) : null;
    return {
      id: id || null,
      name: catalogRow?.name || null,
      discount_type: type,
      amount: Number(amount),
      max_discount_dollars: catalogRow?.max_discount_dollars ?? null,
    };
  };
  let primaryLineDiscount = null;
  if (service.lineDiscountType && service.lineDiscountAmount != null) {
    if (compound) {
      const capEntry = service.pricingProvenance?.caps?.line;
      const cap = capEntry && String(capEntry.id ?? '') === String(service.lineDiscountId ?? '') ? capEntry.cap : null;
      primaryLineDiscount = {
        id: service.lineDiscountId || null, name: service.lineDiscountName || null,
        discount_type: service.lineDiscountType, amount: Number(service.lineDiscountAmount),
        max_discount_dollars: cap,
      };
    } else if (service.lineDiscountDollars != null) {
      primaryLineDiscount = {
        id: service.lineDiscountId || null, name: service.lineDiscountName || null,
        discount_type: 'fixed_amount', amount: Number(service.lineDiscountDollars),
      };
    }
  }
  const primaryGross = body.primaryLinePrice != null ? Number(body.primaryLinePrice) : Number(service.primaryLinePrice ?? 0);
  const existingAddonsById = new Map((service.serviceAddons || []).map((a) => [a.id, a]));
  const addonsIn = Array.isArray(body.addons) ? body.addons : [];
  const addonLines = addonsIn.map((a) => {
    const gross = Number(a.basePrice ?? a.price ?? 0);
    const existing = a.id ? existingAddonsById.get(a.id) : null;
    const serviceKey = a.serviceKey || existing?.serviceKey || null;
    const serviceCategory = a.serviceCategory || existing?.serviceCategory || null;
    let ld = null;
    if (a.discountType && a.discountAmount != null && a.discountAmount !== '') {
      const isFresh = !existing || String(existing.discountId || '') !== String(a.discountId || '')
        || existing.discountType !== a.discountType || Number(existing.discountAmount) !== Number(a.discountAmount);
      if (!isFresh && compound) {
        const capsAddons = service.pricingProvenance?.caps?.addons || {};
        const cap = a.discountId && String(a.discountId) in capsAddons
          ? capsAddons[String(a.discountId)]
          : (discountById.get(a.discountId)?.max_discount_dollars ?? null);
        ld = {
          id: a.discountId || null, name: a.discountName || null, discount_type: a.discountType,
          amount: Number(a.discountAmount), max_discount_dollars: cap,
        };
      } else if (!isFresh && !compound && existing?.discountDollars != null) {
        ld = { id: a.discountId || null, name: a.discountName || null, discount_type: 'fixed_amount', amount: Number(existing.discountDollars) };
      } else {
        ld = resolveFreshDiscount(a.discountType, a.discountAmount, a.discountId);
      }
    }
    return { gross, lineDiscount: ld, submittedAddonId: a.id || null, serviceName: a.serviceName || a.name || '', serviceKey, serviceCategory };
  });
  let appointmentDiscount = null;
  let keyFilter = null;
  let categoryFilter = null;
  if (body.discountType && body.discountAmount != null && body.discountAmount !== '') {
    const presetRow = body.discountId ? discountById.get(body.discountId) : null;
    appointmentDiscount = resolveFreshDiscount(body.discountType, body.discountAmount, body.discountId);
    keyFilter = presetRow?.service_key_filter || null;
    categoryFilter = presetRow?.service_category_filter || null;
  } else if (service.discountType && service.discountAmount != null) {
    appointmentDiscount = resolveFreshDiscount(service.discountType, service.discountAmount, service.discountId);
    keyFilter = service.discountServiceKeyFilter || null;
    categoryFilter = service.discountServiceCategoryFilter || null;
  }
  // Scope the appointment credit to the lines it actually reaches — the
  // same service_key_filter/service_category_filter matching
  // presetEligibilityCheck/resolveUpdateDetailsAddonFinancials apply
  // server-side.
  const inScope = (lineServiceKey, lineServiceCategory) => (
    (!keyFilter || keyFilter === lineServiceKey) && (!categoryFilter || categoryFilter === lineServiceCategory)
  );
  const primaryServiceKey = body.serviceKey !== undefined ? body.serviceKey : (service.serviceKey || null);
  const primaryServiceCategory = body.serviceCategory !== undefined ? body.serviceCategory : (service.serviceCategorySnapshot || null);
  const stacked = stackVisitDiscounts({
    lines: [
      { gross: primaryGross, lineDiscount: primaryLineDiscount, eligible: inScope(primaryServiceKey, primaryServiceCategory) },
      ...addonLines.map((l) => ({ gross: l.gross, lineDiscount: l.lineDiscount, eligible: inScope(l.serviceKey, l.serviceCategory) })),
    ],
    appointmentDiscount,
    compound,
  });
  return {
    total: stacked.total,
    primaryLinePrice: primaryGross,
    appointmentDiscountDollars: stacked.appointmentDiscountDollars,
    primaryLineDiscountDollars: stacked.lines[0]?.lineDiscountDollars ?? null,
    primaryLineDiscountName: primaryLineDiscount?.name || null,
    addons: addonLines.map((l, i) => ({
      submittedAddonId: l.submittedAddonId,
      serviceName: l.serviceName,
      price: stacked.lines[i + 1]?.net,
      discountDollars: stacked.lines[i + 1]?.lineDiscountDollars || null,
      discountName: l.lineDiscount?.name || null,
    })),
  };
}

function mockFetch({ stackingEnabled, discounts = DISCOUNTS, onUpdateDetails, service = baseService } = {}) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      return { ok: true, json: async () => ({ enabled: stackingEnabled }) };
    }
    if (url.endsWith('/admin/discounts')) {
      return { ok: true, json: async () => discounts };
    }
    if (url.includes('/update-details/preview')) {
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), service, discounts) };
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

// Structural round 3 on #4657: the debounced money preview is now a
// non-GET call too (POST .../update-details/preview) but it never
// persists anything — excluded here so "a write happened" still means
// what it always meant: the real PUT save.
const writes = () => fetch.mock.calls.filter(([url, options]) => (
  options?.method && options.method !== 'GET' && !url.includes('/update-details/preview')
));
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

describe('lineDiscountSaveBlocked', () => {
  it('blocks only when the gate is unconfirmed AND both an appointment pick and a line discount are in play', () => {
    // An untouched stamp counts only while its Price still matches its
    // seed — round 2's own :1678 fix.
    const stamped = { _origDiscountType: 'fixed_amount', price: '55', _seededPrice: '55' };
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: true, lines: [stamped] })).toBe(true);
    expect(lineDiscountSaveBlocked({ known: true, appointmentDiscountSelected: true, lines: [stamped] })).toBe(false);
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: false, lines: [stamped] })).toBe(false);
    expect(lineDiscountSaveBlocked({ known: false, appointmentDiscountSelected: true, lines: [{}] })).toBe(false);
    // An explicitly REMOVED line discount is no longer "in play" even though
    // _origDiscountType is still on the row.
    expect(lineDiscountSaveBlocked({
      known: false, appointmentDiscountSelected: true,
      lines: [{ _origDiscountType: 'fixed_amount', lineDiscountTouched: true, lineDiscount: null }],
    })).toBe(false);
    // :1678 (GitHub review round 2 on #4657, P2): a stamp whose Price was
    // edited without touching its discount control is no longer "in play"
    // either — the preview/payload already drop it (origStampOf's own
    // priceEditedFromSeed guard).
    expect(lineDiscountSaveBlocked({
      known: false, appointmentDiscountSelected: true,
      lines: [{ _origDiscountType: 'fixed_amount', price: '70', _seededPrice: '55' }],
    })).toBe(false);
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
  await waitForMoneyReady();
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
  await waitForMoneyReady();
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
  await waitForMoneyReady();
  await waitFor(() => expect(screen.getByText('($4.00)')).toBeInTheDocument());
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
  await waitForMoneyReady();
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

it('structural round on #4657: Save is disabled until the server preview confirms the appointment+line total, then shows the server figure', async () => {
  let resolvePreview;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return new Promise((resolve) => {
        resolvePreview = () => resolve({ ok: true, json: async () => ({ total: 123.45, addons: [] }) });
      });
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // Same ambiguous scenario as the gate-probe test above (appointment pick +
  // the mosquito line's own frozen Military stamp) — this time the STACKING
  // probe itself resolves cleanly and quickly; it is the NEW server money
  // preview (a separate round trip) that Save now waits on.
  await waitFor(() => expect(apptDiscountSelect()).toBeInTheDocument());
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '10' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled(), { timeout: 2000 });
  expect(screen.getByText(/Confirming totals with the server/)).toBeInTheDocument();
  // The 500ms debounce has to actually elapse and the request land before
  // there is anything to resolve.
  await waitFor(() => expect(resolvePreview).toBeInstanceOf(Function), { timeout: 2000 });
  await act(async () => { resolvePreview(); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  // The displayed total is now the SERVER's own figure ($123.45), never a
  // client re-derivation.
  expect(totalText()).toBe('$123.45');
});

it('structural round on #4657: a preview failure blocks Save with a visible error, not a silent stale total', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeInTheDocument());
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '10' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled(), { timeout: 2000 });
  await waitFor(() => expect(screen.getByText(/Could not confirm the totals this save would produce/)).toBeInTheDocument(), { timeout: 2000 });
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
  await waitForMoneyReady();
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
  await waitForMoneyReady();
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  fireEvent.click(save);
  fireEvent.click(save);
  // Codex pre-push audit P1 (round 4 on #4657, :2936): handleSave now
  // re-probes the stacking gate on EVERY save (not just discount+line
  // combos), so the actual PUT (and onUpdateDetails's own resolveSave
  // assignment) fires one microtask later than the click.
  await waitFor(() => expect(resolveSave).toBeInstanceOf(Function));
  await act(async () => { resolveSave(); });
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(writes().filter(([url]) => url.includes('/update-details'))).toHaveLength(1); // preview already excluded by writes() itself
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
  await waitForMoneyReady();
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
  await waitForMoneyReady();
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

// Structural round 3 on #4657: every money figure now comes from a
// debounced server round trip, so Save stays disabled (and the totals
// section still reads "Confirming…") until that response lands — tests
// that assert on a dollar figure, or that click Save, wait for it first.
async function waitForMoneyReady() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled(), { timeout: 2000 });
}

it(':3295 — a MARKED row previews the canonical (compound) engine: fixed-credit reordering clamps the line credit to $2, Total $1.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R3, service: orderingSensitiveService(MARKED_PROVENANCE) }));
  render(<Harness service={orderingSensitiveService(MARKED_PROVENANCE)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '12' } });
  await waitFor(() => expect(totalText()).toBe('$1.00'));
});

it(':3295 — the SAME numbers on an UNMARKED row preview the additive engine instead: the line credit stays full ($5), Total $0.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS_R3, service: orderingSensitiveService(null) }));
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
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: discountsWithLiveCap, service }));
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
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: DISCOUNTS, service }));
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
  await waitForMoneyReady();
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

// ---------------------------------------------------------------------
// GitHub review round 2 on PR #4657 (github.com/wavespestcontrolfl/
// waves-customer-portal/pull/4657, /tmp/t4657-r2.txt): 5 P1 + 1 P2 against
// f107bd2f48. :2386 was already covered by 97f9efa348's own test (same
// applyDiscount-without-a-cap code path, a different repro number); the
// rest are pinned here.
// ---------------------------------------------------------------------

it(':3445 — the PRIMARY line\'s own stored discount (never editable in this slice) is included in the preview total on a MARKED row', async () => {
  const service = {
    ...baseService,
    serviceAddons: [],
    primaryLinePrice: 100,
    estimatedPrice: 100,
    lineDiscountType: 'fixed_amount', lineDiscountAmount: 10, lineDiscountId: 'disc-military',
    pricingProvenance: {
      pricing_regime: 'discount_stack_v1', engine_version: 1,
      caps: { line: { id: 'disc-military', cap: null }, addons: {} },
    },
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // $100 gross primary minus the stored $10 fixed credit — never $100 flat.
  await waitFor(() => expect(totalText()).toBe('$90.00'));
  expect(screen.getByText('Primary line discount')).toBeInTheDocument();
});

it(':3421 — a stored appointment discount scoped to ONE service key previews against only that line\'s base, not the whole visit', async () => {
  const service = {
    ...baseService,
    primaryLinePrice: 100,
    estimatedPrice: 200,
    serviceAddons: [
      { id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly', serviceCategory: 'mosquito', basePrice: 60, estimatedPrice: 60, estimatedDuration: 30 },
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
    discountType: 'percentage', discountAmount: 10, discountId: 'disc-military',
    discountServiceKeyFilter: 'mosquito_monthly', discountServiceCategoryFilter: null,
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // 10% of the mosquito line's own $60 ($6) — never 10% of the full $200
  // subtotal ($20), which is what an unscoped preview would show.
  await waitFor(() => expect(totalText()).toBe('$194.00'));
});

// ---------------------------------------------------------------------
// GitHub pre-push audit round 3 on PR #4657 (0f635fed84): 1 P0 + 4 P1.
// The P0 and two of the P1s (existingFields missing discount_id/primary
// slot; the client never sending addon row ids) are server/payload-shape
// fixes pinned by the real-Postgres suite and by parity with the existing
// :2513 tests (grandfathering now actually works once ids are sent). This
// covers the remaining client-observable one.
// ---------------------------------------------------------------------

it('P1 (round 3): an UNMARKED row\'s primary discount previews at its FROZEN dollar figure, never re-derived from type/amount against a NEW price', async () => {
  const service = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly', serviceCategory: 'mosquito', basePrice: 50, estimatedPrice: 50, estimatedDuration: 30 },
    ],
    primaryLinePrice: 100,
    estimatedPrice: 150,
    lineDiscountType: 'percentage', lineDiscountAmount: 10, lineDiscountId: 'disc-military',
    lineDiscountDollars: 10,
    // Unmarked: no pricingProvenance at all.
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // Edit the primary Price to $200 — a genuine price change. If the
  // preview wrongly re-derived 10% of the NEW $200 ($20), Total would read
  // $230.00. The server can never recompute this (unmarked, never
  // resent), so it always preserves the frozen $10 — Total must be $240.00.
  const priceInputs = await screen.findAllByPlaceholderText('0.00');
  const primaryPriceInput = priceInputs.find((i) => Number(i.value) === 100);
  fireEvent.change(primaryPriceInput, { target: { value: '200' } });
  await waitFor(() => expect(totalText()).toBe('$240.00'));
});

// ---------------------------------------------------------------------
// Structural round 3 on #4657: the server preview is the ONLY money
// source now (no client engine, no "is a discount in play" gating on
// whether to ask it) — these four pin the exact repros GitHub round 3
// found, each closed by construction rather than a targeted patch.
// ---------------------------------------------------------------------

it('structural round 3 on #4657 (:2859): a stored PRIMARY-line discount stacking with a fresh appointment discount is previewed even on a visit with NO add-on lines at all', async () => {
  const service = {
    ...baseService,
    serviceAddons: [],
    primaryLinePrice: 100,
    estimatedPrice: 100,
    lineDiscountType: 'percentage', lineDiscountAmount: 10, lineDiscountId: 'disc-military',
    lineDiscountDollars: 10,
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeInTheDocument());
  // Picking a fresh appointment discount on a visit with only a stored
  // PRIMARY-line discount (no add-ons at all) used to never even ask the
  // server — lineDiscountInPlay only ever looked at add-on serviceLines,
  // so moneyPreviewRelevant (appointmentDiscountSelected && lineDiscountInPlay)
  // stayed false and the client's own stale/optimistic number stood. The
  // preview is unconditional now, so this combination is covered too.
  fireEvent.change(apptDiscountSelect(), { target: { value: 'custom' } });
  fireEvent.change(labeledControl('Discount type'), { target: { value: 'fixed_amount' } });
  fireEvent.change(labeledControl('Amount ($)'), { target: { value: '5' } });
  await waitForMoneyReady();
  // Both discounts actually reached the server and reduced the total —
  // the exact combined figure is the server's own engine choice (additive
  // here, this row is unmarked); the point pinned is that a round trip
  // happened AT ALL for this previously-uncovered combination.
  await waitFor(() => expect(totalText()).not.toBe('$100.00'));
});

it('structural round 3 on #4657 (:3659): a stacking-gate flip invalidates any cached preview even when the discounts are UNTOUCHED (stored, not a fresh pick this session)', async () => {
  // The gate-flip full-reset effect (setServiceLines on stackingEnabled)
  // only has something to reset for a line TOUCHED this session
  // (lineDiscountTouched) — an untouched, merely STORED stamp is exactly
  // the repro GitHub round 3 found: nothing else about the form changes on
  // a gate flip here, so only stackingEnabled/stackingKnown actually being
  // IN the preview's own dependency key can catch it.
  const service = {
    ...baseService,
    discountType: 'percentage', discountAmount: 10, discountId: 'disc-silver', discountMaxDollars: null,
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  // Gate flips off with NOTHING else on the form changing — a fresh
  // vi.fn() fetch, so its own call history starts empty; ANY call to it
  // proves the debounce effect re-ran purely off the gate transition (the
  // OLD dependency key — form/discount/lines only — would never have
  // re-run this effect for an untouched stamp, silently leaving the
  // gate-ON response on screen under the gate-OFF regime).
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: false, service }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => {
    const previewCallsAfterFlip = fetch.mock.calls.filter(([url]) => url.includes('/update-details/preview'));
    expect(previewCallsAfterFlip.length).toBeGreaterThan(0);
  });
});

it('structural round 3 on #4657 (:2394): an unmarked add-on stamp previews its stored dollars even with NO appointment discount in play at all', async () => {
  const service = {
    ...baseService,
    serviceAddons: [
      {
        id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
        serviceCategory: 'mosquito', basePrice: 100, estimatedPrice: 90, discountId: 'disc-silver',
        discountName: 'WaveGuard Silver', discountType: 'percentage', discountAmount: 50, discountDollars: 10,
        estimatedDuration: 30,
      },
    ],
    primaryLinePrice: 0,
    estimatedPrice: 90,
    // Unmarked — no pricingProvenance.
  };
  // The LIVE catalog cap has since dropped to $2 — an unmarked, untouched
  // stamp must still preview at its stored $10, never re-derived against
  // the NEW (lower) live cap, and — the :2394 repro specifically — even
  // though NO appointment discount is anywhere in play this save (the OLD
  // gating required BOTH an appointment pick and a line discount before
  // asking the server at all).
  const discountsWithLoweredCap = DISCOUNTS.map((d) => (
    d.id === 'disc-silver' ? { ...d, max_discount_dollars: 2 } : d
  ));
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: discountsWithLoweredCap, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect().value).toBe(''));
  // $90 (stored, preserved) — never $98 (the raw $100 minus the
  // now-live-capped $2).
  await waitFor(() => expect(totalText()).toBe('$90.00'));
});

it('structural round 3 on #4657 (:3606): the preview request carries the primary service identity (serviceType), not just price and discount fields', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  await waitForMoneyReady();
  const previewCall = fetch.mock.calls.find(([url]) => url.includes('/update-details/preview'));
  expect(previewCall).toBeTruthy();
  const body = JSON.parse(previewCall[1].body);
  // The primary-service identity is IN the request (the same `...form`
  // spread the real save sends) — a primary-service change is therefore
  // always priced/validated against what THIS save would actually
  // resolve, never a stale identity the OLD narrower preview body omitted.
  expect(body.serviceType).toBe(baseService.serviceType);
});

// ---------------------------------------------------------------------
// Round 4 on #4657 (GitHub review): the PUT must consume the plan
// verbatim and nothing money-related may live outside it.
// ---------------------------------------------------------------------

it('round 4 (:2936): the submit-time gate re-probe runs even with NO appointment discount selected — a marked visit with only a capped line stamp', async () => {
  let stackingCalls = 0;
  const service = {
    ...baseService,
    pricingProvenance: {
      pricing_regime: 'discount_stack_v1', engine_version: 1,
      caps: { line: null, addons: { 'disc-military': 5 } },
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      stackingCalls += 1;
      // The FIRST probe (mount) reads on; the SECOND (submit-time
      // re-probe) reads off — a flip that happened while the modal sat
      // open, with no appointment-level discount ever touched.
      return { ok: true, json: async () => ({ enabled: stackingCalls === 1 }) };
    }
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), service, DISCOUNTS) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // No appointment discount is ever selected this session — apptDiscountSelect
  // stays "None" throughout.
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  // The re-probe (round 2 of the stacking call) fires and reports the gate
  // flipped — Save must refuse, not silently post under the wrong regime.
  await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
    expect.stringContaining('The discount-stacking setting changed while this was open'),
  ));
  expect(stackingCalls).toBeGreaterThanOrEqual(2);
});

it('round 4 (:2330): an independent price edit on a previously-undiscounted line survives a gate flip that reverts its fresh discount pick', async () => {
  const twoLinesNoDiscount = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: twoLinesNoDiscount }));
  render(<Harness service={twoLinesNoDiscount} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPriceInput = (await screen.findAllByPlaceholderText('0.00')).find((i) => Number(i.value) === 40);
  // Independent price edit FIRST — nothing about this touches the discount
  // control, so there is nothing for setLineDiscount's own net->gross snap
  // to have caused.
  fireEvent.change(fertPriceInput, { target: { value: '60' } });
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // Gate closes before Save — the fresh Silver pick reverts.
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Line discount for Quarterly Fertilization' })).not.toBeInTheDocument());
  // The $60 the operator typed BEFORE ever touching the discount control
  // survives — it was never a snap side effect of the (now-reverted) pick.
  const fertPriceAfter = (await screen.findAllByPlaceholderText('0.00')).find((i) => i.value === '60');
  expect(fertPriceAfter).toBeTruthy();
});

it('round 4 (:2850): a line preset picked while Price is blank blocks Save instead of silently dropping the discount', async () => {
  const blankPriceLine = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: blankPriceLine }));
  render(<Harness service={blankPriceLine} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPriceInput = (await screen.findAllByPlaceholderText('0.00')).find((i) => Number(i.value) === 40);
  fireEvent.change(fertPriceInput, { target: { value: '' } });
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // Let the (unrelated) server-preview round trip settle first, so the
  // disabled-button assertion below isolates lineDiscountPriceMissing —
  // not a coincidental still-loading moneyPreviewBlocksSave.
  await waitFor(() => expect(screen.queryByText(/Confirming totals with the server/)).not.toBeInTheDocument());
  expect(screen.getByText(/A line has a discount selected but no price/)).toBeInTheDocument();
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  // Blocked at the client — no save attempt reaches the wire at all.
  expect(writes().filter(([url]) => url.includes('/update-details') && !url.includes('/preview'))).toHaveLength(0);
});

// ---------------------------------------------------------------------
// Round 5 on #4657 (GitHub review): two bounded edge cases in the
// per-line reprice/remove flow and the submit-time gate re-probe's own
// scope.
// ---------------------------------------------------------------------

it('round 5 (:2441): repricing a stamped line BEFORE touching its discount control survives a subsequent fresh pick', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  const priceInputs = screen.getAllByPlaceholderText('0.00');
  const mosquitoPrice = priceInputs.find((i) => Number(i.value) === 55);
  expect(mosquitoPrice).toBeTruthy();
  // Independent price edit FIRST — the discount control is still untouched,
  // so there is nothing here for the discount control's own net->gross
  // snap to have caused. Editing Price away from its seed already drops
  // the stale discount from the PREVIEW (:2306/:1678's own fix) — the
  // "chosen" display (and its Remove button) is replaced by the picker,
  // still showing "None" selected, exactly like a line that never had a
  // discount.
  fireEvent.change(mosquitoPrice, { target: { value: '70' } });
  expect(screen.queryByText('Military Discount', { selector: 'div' })).not.toBeInTheDocument();
  const mosquitoPicker = screen.getByRole('combobox', { name: 'Line discount for Monthly Mosquito' });
  // A fresh pick from that picker is the FIRST touch of the discount
  // control this session — setLineDiscount's own firstTouch snap must see
  // Price no longer holds the seeded net ($55) and leave it alone.
  fireEvent.change(mosquitoPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // The operator's own $70 survives — never reset to $60 (_origBasePrice).
  const priceInputsAfter = screen.getAllByPlaceholderText('0.00');
  expect(priceInputsAfter.find((i) => i.value === '70')).toBeTruthy();
  expect(priceInputsAfter.find((i) => Number(i.value) === 60)).toBeFalsy();
});

it('round 5 (:2958): a notes-only save on an UNDISCOUNTED visit skips the submit-time gate probe — an unrelated stacking-endpoint outage never blocks it', async () => {
  let stackingCalls = 0;
  const undiscountedLine = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      stackingCalls += 1;
      // The mount-time probe is allowed through; a submit-time re-probe
      // would hit this same rejection and block the save — the point
      // pinned is that a gate-insensitive save never calls it a second
      // time at all.
      if (stackingCalls > 1) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ enabled: true }) };
    }
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), undiscountedLine, DISCOUNTS) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness service={undiscountedLine} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const notes = await screen.findByDisplayValue('Existing note');
  fireEvent.change(notes, { target: { value: 'Updated note' } });
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  // Exactly one stacking-probe call (the mount) — no submit-time re-probe.
  expect(stackingCalls).toBe(1);
});

// ---------------------------------------------------------------------
// Round 6 on #4657 (GitHub review): the gate-close reset path (separate
// from setLineDiscount's own firstTouch guard) had its own, unsynced copy
// of "was Price snapped this session" — fresh evidence beyond round 5's
// :2441 fix, which only touched the PICK-time guard.
// ---------------------------------------------------------------------

it('round 6 (:2342): an independent reprice BEFORE picking a fresh discount survives a subsequent gate-close reset, not just the pick itself', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  const priceInputs = screen.getAllByPlaceholderText('0.00');
  const mosquitoPrice = priceInputs.find((i) => Number(i.value) === 55);
  expect(mosquitoPrice).toBeTruthy();
  // Independent price edit FIRST, same as :2441 — the discount control is
  // still untouched, so setLineDiscount's own firstTouch has nothing to
  // snap FROM once it fires next.
  fireEvent.change(mosquitoPrice, { target: { value: '70' } });
  const mosquitoPicker = screen.getByRole('combobox', { name: 'Line discount for Monthly Mosquito' });
  // First touch of the discount control this session — :2441 already
  // proved this alone doesn't reset Price. The NEW evidence is what
  // happens next.
  fireEvent.change(mosquitoPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  const priceInputsMidEdit = screen.getAllByPlaceholderText('0.00');
  expect(priceInputsMidEdit.find((i) => i.value === '70')).toBeTruthy();
  // The gate closes before Save — the fresh Silver pick reverts through
  // the SEPARATE gate-close reset effect (:2342), not setLineDiscount.
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Line discount for Monthly Mosquito' })).not.toBeInTheDocument());
  // The operator's own $70 — never touched by any snap this session —
  // must survive the reset. The buggy version restored _seededPrice ($55)
  // for EVERY originally-stamped line regardless of whether ITS OWN touch
  // ever snapped anything.
  const priceInputsAfter = screen.getAllByPlaceholderText('0.00');
  expect(priceInputsAfter.find((i) => i.value === '70')).toBeTruthy();
  expect(priceInputsAfter.find((i) => i.value === '55')).toBeFalsy();
});

// ---------------------------------------------------------------------
// Round 7 on #4657 (GitHub review): a client-side parity pin for the
// server's own round-7 fix (:9465) — the server now LOADS the stored
// discount for a service-only rebase instead of trusting a request echo,
// specifically because the real modal never sends one. This test pins
// that contract from the other side.
// ---------------------------------------------------------------------

it('round 7 (:9465 client parity): a service-only change omits discountType/discountAmount/discountId from the Save payload — the Discount control opens empty, never seeded from the stored stamp', async () => {
  const noAddonDiscountedVisit = {
    ...baseService,
    serviceAddons: [],
    primaryLinePrice: 100,
    estimatedPrice: 90,
    discountType: 'fixed_amount', discountAmount: 10, discountId: 'disc-military',
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: noAddonDiscountedVisit }));
  render(<Harness service={noAddonDiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // Open the primary service picker and swap ONLY the service — Price and
  // the Discount control are both left untouched.
  fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
  fireEvent.click(screen.getByRole('button', { name: /Termite/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Termite Monitoring Service' }));
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.serviceType).toBe('Termite Monitoring Service');
  // The whole point of the server's :9465 fix: these keys are not merely
  // falsy, they are ABSENT — the modal's Discount control state
  // (useState("")) never seeds from the visit's stored stamp, so a
  // service-only save has nothing to echo even if it wanted to.
  expect('discountType' in body).toBe(false);
  expect('discountAmount' in body).toBe(false);
  expect('discountId' in body).toBe(false);
});
