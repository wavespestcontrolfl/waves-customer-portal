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
const FREE_SERVICE = {
  id: 'disc-free', name: 'Free Service', discount_type: 'free_service', amount: 0,
  max_discount_dollars: null, stack_group: null, is_stackable: true,
  is_active: true, is_auto_apply: false, show_in_invoices: true,
};

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
  return screen.getByText(text, { selector: 'label' }).parentElement.querySelector('select, input, textarea');
}
const apptDiscountSelect = () => labeledControl('Discount');
// The "Create invoice on completion" checkbox IS wrapped by its <label>
// (unlike the visual-only siblings above), so its text sits inside a
// <span> next to the <input> — walk up to the label, then back down.
const invoiceCheckbox = () => screen.getByText('Create invoice on completion').closest('label').querySelector('input[type="checkbox"]');

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

// GitHub Codex round 11 on #4657 (P2, SchedulePage.jsx:2381): the line
// picker loads every active invoice discount type, so a free_service
// preset reached the dollar branch and read "Free Service - $0.00" — the
// server discounts the WHOLE line for that type. It reads "Free" here,
// matching Create appointment and the mobile picker.
it('gate on: a free_service preset is labelled "Free" in the line picker, never $0.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: [...DISCOUNTS, FREE_SERVICE] }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  const labels = Array.from(fertPicker.querySelectorAll('option')).map((o) => o.textContent);
  expect(labels).toContain('Free Service - Free');
  expect(labels.some((l) => l.includes('$0.00'))).toBe(false);
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
  // GitHub Codex round 20 P2 (#4657, :3498): the fixed stacked-discount copy
  // is now only the fallback for an EMPTY server message — the server's own
  // message ('stale', forwarded as e.message by adminFetch) is shown
  // instead, since this same code covers route/window/grouping/legacy-price/
  // preview-drift reasons too, each with its own actionable text.
  expect(await screen.findByRole('alert')).toHaveTextContent('stale');
  expect(onSaved).not.toHaveBeenCalled();
  // The modal stays open with the edit intact — nothing was silently lost.
  expect(screen.getByDisplayValue('Updated note')).toBeInTheDocument();
});

it('round 20 P2 (:3498): VISIT_CHANGED_RETRY shows the server\'s own actionable message, not the fixed stacked-discount copy', async () => {
  vi.stubGlobal('fetch', mockFetch({
    stackingEnabled: true,
    onUpdateDetails: async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'This appointment moved while saving — reload and save again.',
        code: 'VISIT_CHANGED_RETRY',
      }),
    }),
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  // Without the fix this reads the fixed stacked-discount copy instead.
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This appointment moved while saving — reload and save again.',
  );
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
  // The appointment Discount control itself is still untouched — it shows
  // the row's own stored stamp as the selected "(current)" option (GitHub
  // round 14 P2 on #4657; it used to read "None" while still applying).
  await waitFor(() => expect(apptDiscountSelect().options[apptDiscountSelect().selectedIndex].textContent).toMatch(/\(current\)/));
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

// GitHub Codex round 21 P2 (#4657, :2935): an overflowing exponent like
// "1e309" parses through parseFloat as Infinity, which the old
// `!isNaN(parseFloat(...))` guards treated as a "valid" price — the
// discount-needs-a-price check passed, buildAddonsPayload posted Infinity
// as basePrice, and JSON.stringify silently dropped it to null on the
// wire. parseFinitePrice must reject it the same way a blank price is
// already rejected.
it('round 21 (:2935): a non-finite typed price ("1e309") on a discounted line blocks Save exactly like a blank price', async () => {
  const fertLineFixture = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: fertLineFixture }));
  render(<Harness service={fertLineFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPriceInput = (await screen.findAllByPlaceholderText('0.00')).find((i) => Number(i.value) === 40);
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  // A real <input type="number"> sanitizes an out-of-range exponent like
  // "1e309" to "" at the DOM layer before React ever sees it (jsdom mirrors
  // spec browser behavior here) — bypass that layer so the component's own
  // JS logic, the thing round 21 P2 actually found, is what's under test:
  // Object.defineProperty over the native value accessor makes the next
  // change event's e.target.value report the raw non-finite string exactly
  // as the component would receive it from any other source (e.g. a pasted
  // value that skips the same-keystroke sanitization).
  Object.defineProperty(fertPriceInput, 'value', { value: '1e309', configurable: true });
  fireEvent.change(fertPriceInput);
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

it('round 21 (:2935): an ordinary exponent price ("1e3") on a discounted line saves normally with a finite basePrice', async () => {
  const fertLineFixture = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: fertLineFixture }));
  render(<Harness service={fertLineFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPriceInput = (await screen.findAllByPlaceholderText('0.00')).find((i) => Number(i.value) === 40);
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  fireEvent.change(fertPriceInput, { target: { value: '1e3' } });
  expect(screen.queryByText(/A line has a discount selected but no price/)).not.toBeInTheDocument();
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const fertLine = body.addons.find((a) => a.serviceId === 'svc-fert');
  expect(fertLine).toMatchObject({ basePrice: 1000, discountType: 'percentage', discountAmount: 10, discountId: 'disc-silver', discountName: 'WaveGuard Silver' });
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
// Owner revert-and-carry on #4657 (this round): a P2 itemization bug —
// shared/legacy-visit-money-submission.cjs:52's zero-add-on NET seed
// (correct for the save-preservation contract) was also feeding the
// Subtotal DISPLAY line, rendering an itemization no arithmetic ever
// produces (Subtotal $90, Discount ($10), Total $90).
// ---------------------------------------------------------------------

it('owner revert-and-carry: a discounted zero-add-on visit renders Subtotal as the GROSS, not the net save-seed — $100 / ($10) / $90', async () => {
  const noAddonDiscountedVisit = {
    ...baseService,
    serviceAddons: [],
    primaryLinePrice: 100,
    estimatedPrice: 90,
    discountType: 'fixed_amount', discountAmount: 10,
  };
  // A genuinely UNTOUCHED save's real-server preview response never sets
  // primaryLinePrice at all (computeSingleServiceEstimatedPricePlan's
  // no-op branch — the one this fixture exercises — never touches
  // updates.primary_line_price; only an actual rebase does). Stubbed
  // directly rather than through computeMockPreview, whose simplified
  // primaryGross precedence (body.primaryLinePrice over service.primaryLinePrice)
  // doesn't reproduce that no-op-vs-rebase distinction — this is the
  // exact response shape the real save-preservation contract produces,
  // and the one the client's own Subtotal fallback (service.primaryLinePrice)
  // exists to handle. appointmentDiscountDollars: 10 is what the real
  // preview now returns for this no-op shape too — it falls back to the
  // row's stored discount_dollars (GitHub round 11 P2 on #4657, pinned on
  // PG in admin-schedule-discount-provenance-fields (a2)).
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return {
        ok: true,
        json: async () => ({
          total: 90, primaryLinePrice: null, appointmentDiscountDollars: 10,
          primaryLineDiscountDollars: null, primaryLineDiscountName: null, addons: [],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness service={noAddonDiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  // Subtotal: falls back to the visit's own STORED gross ($100) — never
  // the net save-seed ($90) form.price carries for the SAVE payload, and
  // never a null the preview's own no-op response leaves unresolved.
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$100.00');
  // Discount: the stored appointment-level discount, applied.
  expect(screen.getByText('Custom Discount').nextElementSibling.textContent).toBe('($10.00)');
  // Total: the server preview's own net total — unaffected by this fix,
  // pinned here so the full itemization is checked together.
  expect(screen.getByText('Total').nextElementSibling.textContent).toBe('$90.00');
});

// ---------------------------------------------------------------------
// GitHub Codex round 9 on #4657 (P2, SchedulePage.jsx:3544): the Subtotal
// line added the pre-conversion client-side add-on total even when the
// server preview had every line zeroed (an eligible member converting a
// priced visit to a free callback) — Subtotal $200 / no discount / Total
// $0.00, an itemization no arithmetic produces. The preview now carries
// each line's own `gross`; gate ON, the Subtotal itemizes THAT.
// ---------------------------------------------------------------------

function zeroedCallbackPreview(url) {
  if (url.endsWith('/admin/discounts/stacking')) return null;
  if (!url.includes('/update-details/preview')) return null;
  return {
    ok: true,
    json: async () => ({
      total: 0, primaryLinePrice: 0, appointmentDiscountDollars: null,
      primaryLineDiscountDollars: null, primaryLineDiscountName: null,
      addons: [
        { submittedAddonId: 'addon-1', serviceName: 'Monthly Mosquito', price: 0, discountDollars: null, discountName: null, gross: 0 },
        { submittedAddonId: 'addon-2', serviceName: 'Quarterly Fertilization', price: 0, discountDollars: null, discountName: null, gross: 0 },
      ],
    }),
  };
}

it('round 9 P2 (:3544): gate ON, a preview that zeroes every line (free-callback conversion) renders Subtotal $0.00 — never the pre-conversion $200 add-on total above a $0.00 Total', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return zeroedCallbackPreview(url) || { ok: true, json: async () => ({}) };
  }));
  render(<Harness service={baseService} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$0.00');
  expect(totalText()).toBe('$0.00');
});

it('round 9 P2 (:3544): a preview row WITHOUT a gross figure (a blank-priced, quote-pending line the server leaves null) keeps the form\'s own gross for that line', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return {
        ok: true,
        json: async () => ({
          total: 195, primaryLinePrice: 100, appointmentDiscountDollars: null,
          primaryLineDiscountDollars: null, primaryLineDiscountName: null,
          addons: [
            { submittedAddonId: 'addon-1', serviceName: 'Monthly Mosquito', price: 55, discountDollars: 5, discountName: 'Military Discount', gross: 60 },
            { submittedAddonId: 'addon-2', serviceName: 'Quarterly Fertilization', price: 40, discountDollars: null, discountName: null, gross: null },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness service={baseService} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  // 100 (preview primary) + 60 (preview gross) + 40 (form fallback) = 200
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$200.00');
});

it('round 9 P2 (:3544) gate-OFF parity: the Subtotal never reads the preview\'s gross — the pre-lane form sum stands even when the preview zeroes every line', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return zeroedCallbackPreview(url) || { ok: true, json: async () => ({}) };
  }));
  render(<Harness service={baseService} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  // Gate off: primary from the preview's own primaryLinePrice (0 — that
  // precedence predates this fix) + the form's untouched add-on sum
  // (55 net seed + 40) exactly as the pre-lane formula computed it.
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$95.00');
});

// ---------------------------------------------------------------------
// GitHub Codex round 10 on #4657.
// ---------------------------------------------------------------------

it('round 10 P2 (:2328): a price edited AFTER the discount snap ($55 -> snapped $60 -> typed $70) survives the gate-close reset; the snap alone still unwinds', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getAllByText('Military Discount').length).toBeGreaterThan(0));
  // First touch on the already-stamped mosquito line (Remove) snaps its seeded $55 net to the $60 gross.
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove line discount' })[0]);
  const snapped = await waitFor(() => {
    const input = screen.getAllByPlaceholderText('0.00').find((i) => i.value === '60');
    expect(input).toBeTruthy();
    return input;
  });
  // Then an explicit reprice on top of the snap.
  fireEvent.change(snapped, { target: { value: '70' } });
  // Gate closes before Save.
  __resetDiscountStackingCache();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: false }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Line discount for Quarterly Fertilization' })).not.toBeInTheDocument());
  const inputsAfter = screen.getAllByPlaceholderText('0.00').map((i) => i.value);
  expect(inputsAfter).toContain('70'); // the operator's own edit survives
  expect(inputsAfter).not.toContain('55'); // never silently reset to the net seed
});

it('round 10 P1 (legacy-visit-money-submission.cjs:49): a zero-add-on visit with a known $100 gross posts estimatedPrice 100 when its appointment discount is REPLACED — never the $90 net the discount would then compound onto ($72)', async () => {
  const zeroAddonDiscounted = {
    ...baseService,
    serviceAddons: [],
    primaryLinePrice: 100,
    estimatedPrice: 90,
    discountType: 'percentage', discountAmount: 10,
  };
  const writesSeen = [];
  vi.stubGlobal('fetch', mockFetch({
    stackingEnabled: true,
    service: zeroAddonDiscounted,
    onUpdateDetails: (body) => { writesSeen.push(body); return { ok: true, json: async () => ({}) }; },
  }));
  render(<Harness service={zeroAddonDiscounted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeInTheDocument());
  fireEvent.change(apptDiscountSelect(), { target: { value: 'disc-gold' } }); // 15% replaces the stored 10%
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writesSeen.length).toBe(1));
  const body = writesSeen[0];
  expect(Number(body.estimatedPrice)).toBe(100); // the GROSS — the server applies the new 15% to this figure ($85), never to $90 ($76.50)
  expect(body.discountType).toBe('percentage');
  expect(Number(body.discountAmount)).toBe(15);
  expect(body.addons).toBeUndefined(); // zero-add-on: the single-service save path
});

it('round 10 audit P1 (:3468): once a preview is confirmed, retyping a price disables Save on that same render — before the 500ms debounce ever re-requests', async () => {
  let previewCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      previewCalls += 1;
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), baseService, DISCOUNTS) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  const callsAtConfirm = previewCalls;
  const fertPriceInput = screen.getAllByPlaceholderText('0.00').find((i) => Number(i.value) === 40);
  fireEvent.change(fertPriceInput, { target: { value: '200' } });
  // Synchronously stale: no new preview request has fired yet (debounce),
  // yet Save is already disabled and the total reads as unconfirmed.
  expect(previewCalls).toBe(callsAtConfirm);
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(screen.getByText(/Confirming totals with the server/)).toBeInTheDocument();
  // And it re-enables only once the NEW preview lands.
  await waitForMoneyReady();
  expect(previewCalls).toBeGreaterThan(callsAtConfirm);
});

it('round 10 audit P1 (:2974): a marked visit whose ONLY discount is the stored PRIMARY-line one still re-probes the gate at submit and refuses on a flip', async () => {
  let stackingCalls = 0;
  const service = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 50, estimatedPrice: 50, estimatedDuration: 20 },
    ],
    primaryLinePrice: 100, estimatedPrice: 140,
    lineDiscountType: 'percentage', lineDiscountAmount: 10, lineDiscountId: 'disc-silver',
    pricingProvenance: {
      pricing_regime: 'discount_stack_v1', engine_version: 1,
      caps: { line: { id: 'disc-silver', cap: null }, addons: {} },
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      stackingCalls += 1;
      return { ok: true, json: async () => ({ enabled: stackingCalls === 1 }) }; // flips after mount
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
  await waitForMoneyReady();
  // Reprice the primary — the exact edit whose saved total differs by regime.
  const primaryInput = screen.getAllByPlaceholderText('0.00').find((i) => Number(i.value) === 100);
  fireEvent.change(primaryInput, { target: { value: '200' } });
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
    expect.stringContaining('The discount-stacking setting changed while this was open'),
  ));
  expect(stackingCalls).toBeGreaterThanOrEqual(2);
  expect(writes()).toHaveLength(0); // nothing posted under the wrong regime
});

// ---------------------------------------------------------------------
// Codex review round 12 on #4657: 1 P0 + 2 P2.
// ---------------------------------------------------------------------

it('P0 (:2349): a legacy add-on with an unknown gross (base_price never recorded) locks its Line discount picker instead of letting a replacement pick post the stored net as basePrice', async () => {
  const legacyNullGrossAddon = {
    ...baseService,
    serviceAddons: [
      {
        id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
        serviceCategory: 'mosquito', basePrice: null, estimatedPrice: 55, discountId: 'disc-military',
        discountName: 'Military Discount', discountType: 'fixed_amount', discountAmount: 5, discountDollars: 5,
        estimatedDuration: 30,
      },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: legacyNullGrossAddon }));
  render(<Harness service={legacyNullGrossAddon} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const notice = await screen.findByText(/Discount can't be changed on this legacy line/);
  // 14px readability floor (AGENTS.md / CLAUDE.md).
  expect(notice.style.fontSize).toBe('14px');
  // No picker at all — nothing in this modal can post a replacement pick
  // for this line.
  expect(screen.queryByRole('combobox', { name: 'Line discount for Monthly Mosquito' })).not.toBeInTheDocument();
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  const mosquitoLine = body.addons.find((a) => a.serviceId === 'svc-mosquito');
  // Flat net only — never a discountType with the stored NET posted as a
  // fresh basePrice (which would let the server double-discount the line).
  expect(mosquitoLine).toMatchObject({ price: 55 });
  expect(mosquitoLine.basePrice).toBeUndefined();
  expect(mosquitoLine.discountType).toBeUndefined();
});

it('P2 (:3622): gate off, the stored per-line discount is never itemized as its own row between Subtotal and Total (Subtotal $195 / no Line discount row / Total $195)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: false }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$195.00');
  expect(totalText()).toBe('$195.00');
  // The stored Military stamp must never surface as its own itemized row
  // gate-off — Subtotal and Total already read the same flat figure; a
  // "Line discount" row between them would claim an extra $5 credit no
  // arithmetic here actually applies (this modal must stay byte-identical
  // to before this lane).
  expect(screen.queryByText('Military Discount', { selector: 'div' })).not.toBeInTheDocument();
  expect(screen.queryByText('($5.00)')).not.toBeInTheDocument();
});

it('P2 (:2990): form inputs are frozen while the submit-time gate re-probe is in flight, so a stale edit typed underneath it never reaches the save', async () => {
  let stackingCalls = 0;
  let resolveSecondProbe;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      stackingCalls += 1;
      // The FIRST probe (mount) resolves immediately; the SECOND (the
      // submit-time re-probe) stays pending until the test resolves it —
      // this is the exact window a slow probe leaves open.
      if (stackingCalls === 1) return { ok: true, json: async () => ({ enabled: true }) };
      return new Promise((resolve) => { resolveSecondProbe = resolve; });
    }
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), baseService, DISCOUNTS) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  const notes = screen.getByDisplayValue('Existing note');
  const mosquitoPrice = screen.getAllByPlaceholderText('0.00').find((i) => Number(i.value) === 55);
  // baseService's stored Military stamp on the mosquito line makes this
  // save gate-sensitive with no appointment discount ever touched, so the
  // re-probe runs unconditionally (round 4 (:2936)'s own repro class).
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(resolveSecondProbe).toBeInstanceOf(Function));
  // The re-probe is now in flight — every field the stale-closure bug can
  // resume with must be frozen, not just the Save button.
  expect(notes).toBeDisabled();
  expect(mosquitoPrice).toBeDisabled();
  // The button itself already reads "Saving..." (pre-existing behavior) —
  // no "Save" button is left to double-click.
  expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
  await act(async () => { resolveSecondProbe({ ok: true, json: async () => ({ enabled: true }) }); });
  await waitFor(() => expect(writes()).toHaveLength(1));
  // Nothing could have been typed during the frozen window — the exact
  // original note is what saved, never a value the closure could have
  // gone stale on.
  const body = JSON.parse(writes()[0][1].body);
  expect(body.notes).toBe('Existing note');
});

// ---------------------------------------------------------------------
// GitHub Codex round 13 on #4657.
// P0 (admin-schedule.js:10660) + P2 (SchedulePage.jsx:4888): when the
// primary gross is unknown (primary_line_price NULL) and a stored discount
// sits ANYWHERE on the visit, the server refuses every discount-term
// change with LEGACY_PRIMARY_GROSS_UNKNOWN — so the appointment Discount
// picker and every add-on Line discount picker must lock up front, never
// let the operator complete a confirmed-looking edit that fails at the PUT.
// ---------------------------------------------------------------------

const legacyApptDiscountVisit = {
  ...baseService,
  serviceAddons: [],
  primaryLinePrice: null,
  estimatedPrice: 90,
  discountType: 'fixed_amount', discountAmount: 10,
};
// The P0 shape: no parent-level discount at all — the stored discount
// lives on an existing add-on with a known base_price.
const legacyAddonDiscountVisit = {
  ...baseService,
  primaryLinePrice: null,
  estimatedPrice: 190,
  serviceAddons: [
    {
      id: 'addon-1', serviceId: 'svc-mosquito', serviceName: 'Monthly Mosquito', serviceKey: 'mosquito_monthly',
      serviceCategory: 'mosquito', basePrice: 100, estimatedPrice: 90, discountId: 'disc-military',
      discountName: 'Military Discount', discountType: 'fixed_amount', discountAmount: 10, discountDollars: 10,
      estimatedDuration: 30,
    },
  ],
};

it('round 13 P2 (:4888): gate ON, a legacy visit with NULL primary gross and a stored APPOINTMENT discount locks the appointment Discount picker with a 14px notice', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: legacyApptDiscountVisit }));
  render(<Harness service={legacyApptDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeDisabled());
  const notice = screen.getByText(/Discounts can't be changed on this legacy visit/);
  expect(notice.style.fontSize).toBe('14px');
  expect(screen.getByRole('button', { name: 'Add discount' })).toBeDisabled();
});

it('round 13 P0 (:10660): gate ON, a legacy visit with NULL primary gross and a stored ADD-ON discount (no parent discount) locks the appointment picker AND the add-on line picker', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: legacyAddonDiscountVisit }));
  render(<Harness service={legacyAddonDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeDisabled());
  // No picker is wired for the add-on line at all — nothing can post a
  // changed term for it.
  expect(screen.queryByRole('combobox', { name: 'Line discount for Monthly Mosquito' })).not.toBeInTheDocument();
  expect(screen.getAllByText(/Discount can't be changed on this legacy line/).length).toBeGreaterThan(0);
});

it('round 13 (:4888) gate-off parity: the same legacy shape leaves the appointment Discount picker enabled with no notice', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: false, service: legacyApptDiscountVisit }));
  render(<Harness service={legacyApptDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(apptDiscountSelect()).toBeEnabled();
  expect(screen.queryByText(/Discounts can't be changed on this legacy visit/)).not.toBeInTheDocument();
});

// P2 (:3011): a field edited while the save-time gate re-probe is pending
// is not in the awaiting closure's payload — the save must refuse rather
// than silently post the pre-edit value and close the modal.
it('round 13 P2 (:3011): a Date edit made while the save-time gate probe is pending aborts the save instead of posting the stale date', async () => {
  let stackingCalls = 0;
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) {
      stackingCalls += 1;
      // Mount probe answers at once; the save-time re-probe hangs until
      // the test releases it.
      if (stackingCalls > 1) await probeGate;
      return { ok: true, json: async () => ({ enabled: true }) };
    }
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return { ok: true, json: async () => computeMockPreview(JSON.parse(options.body), baseService, DISCOUNTS) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(stackingCalls).toBeGreaterThanOrEqual(2));
  // The Date control is not frozen by `saving` — the operator moves the
  // visit while the probe is still out.
  fireEvent.change(labeledControl('Date'), { target: { value: '2035-01-09' } });
  await act(async () => { releaseProbe(); });
  await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
    expect.stringContaining('Something changed while the discount setting was being checked'),
  ));
  expect(writes()).toHaveLength(0);
  // The modal stays open with the operator's edit intact.
  expect(labeledControl('Date').value).toBe('2035-01-09');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
});

it('round 13 P2 (:3011): an untouched form during the probe still saves normally (the guard only fires on drift)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
});

// ---------------------------------------------------------------------
// GitHub Codex round 14 on #4657.
// ---------------------------------------------------------------------

// P1 (:3597): a failed preview (5xx / network) must not disable a save
// that cannot change money; anything money-bearing still waits.
const undiscountedVisit = {
  ...baseService,
  estimatedPrice: 140,
  serviceAddons: [
    {
      id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert',
      serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20,
    },
  ],
};
function previewDownFetch(service) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return { ok: false, status: 503, json: async () => ({ error: 'preview unavailable' }) };
    }
    if (url.includes('/update-details')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  });
}

it('round 14 P1 (:3597): preview 503 on an UNDISCOUNTED visit — a notes-only save is still allowed and posts', async () => {
  vi.stubGlobal('fetch', previewDownFetch(undiscountedVisit));
  render(<Harness service={undiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByText(/Could not confirm the totals/)).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  expect(screen.getByText(/This save changes no pricing/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
});

it('round 14 P1 (:3597): preview 503 on a visit with a STORED line discount keeps Save disabled', async () => {
  vi.stubGlobal('fetch', previewDownFetch(baseService));
  render(<Harness service={baseService} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByText(/Could not confirm the totals/)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(screen.queryByText(/This save changes no pricing/)).not.toBeInTheDocument();
});

it('round 14 P1 (:3597): preview 503 on an undiscounted visit — editing the Price re-blocks Save', async () => {
  vi.stubGlobal('fetch', previewDownFetch(undiscountedVisit));
  render(<Harness service={undiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  const priceInputs = screen.getAllByPlaceholderText('0.00');
  fireEvent.change(priceInputs[0], { target: { value: '150' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled(), { timeout: 2000 });
});

// P2 (:2494): a stored appointment discount is selectable as "(current)"
// and choosing None posts an explicit null (remove), never undefined
// (leave alone).
const storedApptDiscountVisit = {
  ...baseService,
  serviceAddons: [],
  primaryLinePrice: 100,
  estimatedPrice: 90,
  discountType: 'fixed_amount', discountAmount: 10,
};

it('round 14 P2 (:2494): the stored appointment discount renders as the selected "(current)" option, and None posts discountType null on save', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: storedApptDiscountVisit }));
  render(<Harness service={storedApptDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  const select = apptDiscountSelect();
  expect(select.options[select.selectedIndex].textContent).toMatch(/\(current\)/);
  fireEvent.change(select, { target: { value: '' } });
  expect(screen.getByText(/The stored discount will be removed when you save/).style.fontSize).toBe('14px');
  await waitForMoneyReady();
  // The preview asked for the cleared shape too.
  const previewBodies = fetch.mock.calls.filter(([u]) => u.includes('/update-details/preview')).map(([, o]) => JSON.parse(o.body));
  expect(previewBodies[previewBodies.length - 1].discountType).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.discountType).toBeNull();
  expect(body.discountAmount).toBeNull();
  expect(body.discountId).toBeNull();
});

it('round 14 P2 (:2494): returning to the "(current)" option after None posts undefined again (leave the stored discount alone)', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: storedApptDiscountVisit }));
  render(<Harness service={storedApptDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  fireEvent.change(apptDiscountSelect(), { target: { value: '' } });
  const current = [...apptDiscountSelect().options].find((o) => /\(current\)/.test(o.textContent));
  fireEvent.change(apptDiscountSelect(), { target: { value: current.value } });
  expect(screen.queryByText(/The stored discount will be removed/)).not.toBeInTheDocument();
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.discountType).toBeUndefined();
});

// ---------------------------------------------------------------------
// GitHub Codex round 15 on PR #4657: 4 P2/P1 against 19892edc23.
// ---------------------------------------------------------------------

function mockFetchWithSeriesSummary(opts, seriesSummary) {
  const base = mockFetch(opts);
  return vi.fn(async (url, options) => {
    if (url.endsWith('/series-summary')) {
      return { ok: true, json: async () => seriesSummary };
    }
    return base(url, options);
  });
}

it('round 15 P2 (:2735): choosing None on a stored appointment discount on a series row activates "Apply price & service change to"', async () => {
  const service = {
    ...baseService,
    isRecurring: true,
    recurringParentId: 'series-1',
    discountType: 'percentage', discountAmount: 10, discountId: 'disc-military', discountMaxDollars: null,
  };
  vi.stubGlobal('fetch', mockFetchWithSeriesSummary(
    { stackingEnabled: true, service },
    { series: true, canScopePriceService: true, upcomingCount: 3, ongoing: true },
  ));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  // Nothing dirty yet — the scope control is not offered.
  expect(screen.queryByText('Apply price & service change to')).not.toBeInTheDocument();
  // Choose None on the stored discount — discountType stays "" the whole
  // time (only storedDiscountCleared flips), so without the fix
  // discountDirty never sees this as a change and the control never
  // renders, silently preventing the removal from ever reaching later
  // visits in the series.
  fireEvent.change(apptDiscountSelect(), { target: { value: '' } });
  await waitFor(() => expect(screen.getByText('Apply price & service change to')).toBeInTheDocument());
});

it('round 15 P2 (:2567/:2585): a primary-line catalog discount from a non-stackable group hides the OTHER preset of that group on an add-on picker and the appointment select, but still offers a stackable one', async () => {
  const service = {
    ...baseService,
    serviceAddons: [
      // No discount of its own — the picker renders in "None" state.
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
    lineDiscountType: 'percentage', lineDiscountAmount: 10, lineDiscountId: 'disc-silver',
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  const fertOptionNames = [...fertPicker.options].map((o) => o.textContent);
  // GOLD shares Silver's 'waveguard' stack_group — hidden. Military has no
  // group at all — still offered.
  expect(fertOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
  expect(fertOptionNames.some((t) => t.includes('Military Discount'))).toBe(true);
  const apptOptionNames = [...apptDiscountSelect().options].map((o) => o.textContent);
  expect(apptOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
  expect(apptOptionNames.some((t) => t.includes('Military Discount'))).toBe(true);
});

it('round 15 P2 (:5003): the stored appointment discount\'s "(current)" option formats free_service and variable_percentage correctly', async () => {
  const freeService = { ...baseService, serviceAddons: [], discountType: 'free_service', discountAmount: 0 };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: freeService }));
  const { unmount } = render(<Harness service={freeService} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  let select = apptDiscountSelect();
  expect(select.options[select.selectedIndex].textContent).toMatch(/\(current\) - Free$/);
  unmount();
  cleanup();

  const variablePct = { ...baseService, serviceAddons: [], discountType: 'variable_percentage', discountAmount: 15 };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: variablePct }));
  render(<Harness service={variablePct} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  select = apptDiscountSelect();
  expect(select.options[select.selectedIndex].textContent).toMatch(/\(current\) - 15%$/);
});

it('round 15 P1 (:3133/:3019): a save after a confirmed preview sends expectedTotal, the confirmed total', async () => {
  const service = { ...baseService, serviceAddons: [], primaryLinePrice: 123.45, estimatedPrice: 123.45 };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(totalText()).toBe('$123.45'));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body.expectedTotal).toBe(123.45);
});

it('round 15 P1 (:3133/:3019): a save with no resolved preview total (r14 saveTouchesMoney path, preview down on an undiscounted visit) omits expectedTotal', async () => {
  vi.stubGlobal('fetch', previewDownFetch(undiscountedVisit));
  render(<Harness service={undiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  expect(body).not.toHaveProperty('expectedTotal');
});

// ---------------------------------------------------------------------
// GitHub Codex round 16 on #4657, three P2s against bd661ea8c5.
// ---------------------------------------------------------------------

// :2413 — the round-15 test above (:1855) covers an ACTIVE primary-line
// catalog discount hiding its stack-group sibling. A stored stamp can
// outlive its preset going inactive: linePresetById used to search only
// the active/visible list, so a retired non-stackable preset resolved no
// stack_group at all and its sibling tier stayed offered right up until
// the server's own (unfiltered) stack-group check 400'd the save.
it('round 16 P2 (:2413): a RETIRED primary-line catalog discount still hides its stack-group sibling (metadata falls back to the unfiltered catalog)', async () => {
  const retiredSilver = { ...SILVER, is_active: false };
  const service = {
    ...baseService,
    serviceAddons: [
      // No discount of its own — the picker renders in "None" state.
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
    lineDiscountType: 'percentage', lineDiscountAmount: 10, lineDiscountId: 'disc-silver',
    lineDiscountName: 'WaveGuard Silver', lineDiscountDollars: 10,
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: [MILITARY, retiredSilver, GOLD], service }));
  render(<Harness service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  const fertOptionNames = [...fertPicker.options].map((o) => o.textContent);
  // GOLD shares the RETIRED Silver's 'waveguard' stack_group — still hidden,
  // even though Silver itself is no longer active/offered anywhere.
  expect(fertOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
  // Military carries no group at all — still offered (a stackable preset
  // remains available even with the retired stamp in play).
  expect(fertOptionNames.some((t) => t.includes('Military Discount'))).toBe(true);
  const apptOptionNames = [...apptDiscountSelect().options].map((o) => o.textContent);
  expect(apptOptionNames.some((t) => t.includes('WaveGuard Gold'))).toBe(false);
  expect(apptOptionNames.some((t) => t.includes('Military Discount'))).toBe(true);
});

// :4245 — the round-11 test above (:351) covers the free_service LABEL in
// the picker's own option list. The chosen-line SUMMARY box (rendered once
// a free_service preset is actually picked) fell through to the dollar
// branch instead, showing "$0.00 · ($40.00)" — misstating a full-service
// credit as a zero-dollar one.
it('round 16 P2 (:4245): a chosen free_service line discount renders "Free" in the selected-line summary, never $0.00', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, discounts: [...DISCOUNTS, FREE_SERVICE] }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPicker = await screen.findByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-free' } });
  await waitFor(() => expect(screen.getAllByText('Free Service').length).toBeGreaterThan(0));
  await waitForMoneyReady();
  // free_service discounts the WHOLE $40 fert line — the summary must read
  // "Free", never "$0.00".
  expect(screen.getByText(/^Free · \(\$40\.00\)$/)).toBeInTheDocument();
  expect(screen.queryByText(/^\$0\.00 ·/)).not.toBeInTheDocument();
});

// :5318 — the Total cell rendered "Confirming…" whenever appointmentTotal
// was null and there was no preview error, but a successful preview of a
// legitimately unpriced visit also returns total null with moneyPreviewFresh
// true, so it read stuck even though Save was already enabled.
function previewUnpricedFetch(service, discounts = DISCOUNTS) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => discounts };
    if (url.includes('/update-details/preview')) {
      // A CONFIRMED response — no error — that resolves to no priceable
      // total at all (e.g. a visit the pricing engine can't quote yet).
      return { ok: true, json: async () => ({ total: null, primaryLinePrice: null, appointmentDiscountDollars: 0, addons: [] }) };
    }
    if (url.includes('/update-details')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  });
}
it('round 16 P2 (:5318): a CONFIRMED preview of a legitimately unpriced visit reads "Not priced", never a stuck "Confirming…"', async () => {
  vi.stubGlobal('fetch', previewUnpricedFetch(undiscountedVisit));
  render(<Harness service={undiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // The preview IS fresh/confirmed (no error) — Save is already enabled —
  // even though it resolved to no total.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  expect(totalText()).toBe('Not priced');
  expect(screen.queryByText('Confirming…')).not.toBeInTheDocument();
});

// :3330 — a save after the CONFIRMED-but-unpriced preview above has to
// witness that confirmed state too. Sending no expectedTotal at all here is
// indistinguishable from "never previewed", so a stale save could silently
// overwrite a price a concurrent editor just confirmed.
it('round 20 P1 (:3330): a save after a CONFIRMED preview resolving to no total sends expectedTotal: null, the confirmed-unpriced witness', async () => {
  vi.stubGlobal('fetch', previewUnpricedFetch(undiscountedVisit));
  render(<Harness service={undiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0][1].body);
  // The key itself must be present (an explicit null), not merely absent —
  // without the fix this omits the key entirely, same as never previewed.
  expect('expectedTotal' in body).toBe(true);
  expect(body.expectedTotal).toBe(null);
});

// ---------------------------------------------------------------------
// GitHub Codex round 19 P2 (#4657, :3737): createInvoice seeds from the
// visit's own stored create_invoice_on_complete, so `!!createInvoice`
// alone kept saveTouchesMoney true for the ENTIRE life of the modal on a
// visit invoicing was already on for — never re-derived from an actual
// change. Paired with a permanently-failed preview (r14's
// previewErroredForLatest path), that left Save disabled forever on an
// edit (notes, scheduling) that never touched money at all.
// ---------------------------------------------------------------------

const undiscountedVisitWithInvoice = {
  ...undiscountedVisit,
  create_invoice_on_complete: true,
};

it('round 19 P2 (:3737): preview permanently down on an undiscounted visit with invoicing already on — a notes-only edit still saves, then toggling the invoice checkbox re-blocks Save', async () => {
  vi.stubGlobal('fetch', previewDownFetch(undiscountedVisitWithInvoice));
  render(<Harness service={undiscountedVisitWithInvoice} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(screen.getByText(/Could not confirm the totals/)).toBeInTheDocument());
  fireEvent.change(labeledControl('Appointment notes'), { target: { value: 'Rescheduled per customer request' } });
  // Nothing money-bearing changed (notes isn't part of moneyEditKey, and
  // createInvoice is untouched from its mount-time seed) — Save must be
  // enabled despite the permanently-failed preview.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
  fireEvent.click(invoiceCheckbox());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled());
});

// ---------------------------------------------------------------------
// GitHub Codex round 19 P2 (#4657, :3768): displayPrimaryGross falls back
// to the (net) form seed when neither the preview's own primaryLinePrice
// nor the visit's stored primaryLinePrice is known. For a zero-add-on
// legacy visit with NO recorded gross and a STORED discount, that seed IS
// the net, and rendering it as "Subtotal" produces an itemization no
// arithmetic ever creates (Subtotal $90 / Discount ($10) / Total $90).
// ---------------------------------------------------------------------

const legacyNoGrossDiscountedVisit = {
  ...baseService,
  serviceAddons: [],
  primaryLinePrice: null,
  estimatedPrice: 90,
  discountType: 'fixed_amount', discountAmount: 10,
};

function legacyNoGrossPreviewFetch({ appointmentDiscountDollars }) {
  return vi.fn(async (url) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      return {
        ok: true,
        json: async () => ({
          total: 90, primaryLinePrice: null, appointmentDiscountDollars,
          primaryLineDiscountDollars: null, primaryLineDiscountName: null, addons: [],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
}

it('round 19 P2 (:3768): a legacy visit with NO recorded gross and a stored discount renders Subtotal as "—" with a note, never the net as if it were the gross', async () => {
  vi.stubGlobal('fetch', legacyNoGrossPreviewFetch({ appointmentDiscountDollars: 10 }));
  render(<Harness service={legacyNoGrossDiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('—');
  const note = screen.getByText('Original price not recorded');
  expect(note.style.fontSize).toBe('14px');
  expect(screen.getByText('Custom Discount').nextElementSibling.textContent).toBe('($10.00)');
  expect(screen.getByText('Total').nextElementSibling.textContent).toBe('$90.00');
});

it('round 19 P2 (:3768): the same shape with NO stored discount still falls back to the (net) seed — nothing to correct', async () => {
  const legacyNoGrossUndiscountedVisit = { ...legacyNoGrossDiscountedVisit, discountType: undefined, discountAmount: undefined };
  vi.stubGlobal('fetch', legacyNoGrossPreviewFetch({ appointmentDiscountDollars: null }));
  render(<Harness service={legacyNoGrossUndiscountedVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(screen.getByText('Subtotal').nextElementSibling.textContent).toBe('$90.00');
  expect(screen.queryByText('Original price not recorded')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------
// GitHub Codex round 23 on #4657 — three client P2s.
// ---------------------------------------------------------------------

// P2 (:1685): a finite NEGATIVE price ("-1") passed parseFinitePrice, so a
// discounted line was posted with basePrice -1 — the server's toMoney
// nulls it, dropping the picked discount and persisting an unpriced line.
it('round 23 (:1685): a negative typed price ("-1") on a discounted line blocks Save exactly like a blank price', async () => {
  const fertLineFixture = {
    ...baseService,
    serviceAddons: [
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: fertLineFixture }));
  render(<Harness service={fertLineFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const fertPriceInput = (await screen.findAllByPlaceholderText('0.00')).find((i) => Number(i.value) === 40);
  fireEvent.change(fertPriceInput, { target: { value: '-1' } });
  const fertPicker = screen.getByRole('combobox', { name: 'Line discount for Quarterly Fertilization' });
  fireEvent.change(fertPicker, { target: { value: 'disc-silver' } });
  await waitFor(() => expect(screen.getAllByText('WaveGuard Silver').length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText(/Confirming totals with the server/)).not.toBeInTheDocument());
  expect(screen.getByText(/A line has a discount selected but no price/)).toBeInTheDocument();
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  // Blocked at the client — nothing with basePrice -1 ever reaches the wire.
  expect(writes().filter(([url]) => url.includes('/update-details') && !url.includes('/preview'))).toHaveLength(0);
});

// P2 (:3517): after a VISIT_CHANGED_RETRY the old preview stayed "fresh",
// so the next click resent the same stale expectedTotal and got the same
// 409 forever unless the operator happened to edit a field.
it('round 23 (:3517): a VISIT_CHANGED_RETRY invalidates the confirmed preview and re-runs it, so the next Save carries the server\'s CURRENT total, not the refused witness', async () => {
  let refusals = 0;
  let previewTotal = 195;
  const previewCalls = () => fetch.mock.calls.filter(([url]) => url.includes('/update-details/preview')).length;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/admin/discounts/stacking')) return { ok: true, json: async () => ({ enabled: true }) };
    if (url.endsWith('/admin/discounts')) return { ok: true, json: async () => DISCOUNTS };
    if (url.includes('/update-details/preview')) {
      // The "server" reprices the visit between the first preview and
      // the first save (a catalog change) — the same total-drift the
      // route's PREVIEW_TOTAL_DRIFT reason refuses.
      return { ok: true, json: async () => ({ ...computeMockPreview(JSON.parse(options.body), baseService, DISCOUNTS), total: previewTotal }) };
    }
    if (url.includes('/update-details')) {
      const body = JSON.parse(options.body);
      if (body.expectedTotal !== 200) {
        refusals += 1;
        previewTotal = 200;
        return { ok: false, status: 409, json: async () => ({ code: 'VISIT_CHANGED_RETRY', reason: 'PREVIEW_TOTAL_DRIFT', error: 'The total changed since it was previewed — review the new total and save again.' }) };
      }
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  const onSaved = vi.fn();
  render(<Harness onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  await waitFor(() => expect(totalText()).toBe('$195.00'));
  const previewsBefore = previewCalls();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('review the new total and save again');
  expect(refusals).toBe(1);
  // Without the fix: no new preview request, the $195 figure stays
  // "fresh", and the next click resends expectedTotal 195 → 409 again.
  await waitFor(() => expect(previewCalls()).toBeGreaterThan(previewsBefore));
  await waitFor(() => expect(totalText()).toBe('$200.00'));
  await waitForMoneyReady();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(refusals).toBe(1);
  const saves = writes().filter(([url]) => url.includes('/update-details') && !url.includes('/preview'));
  expect(saves).toHaveLength(2);
  expect(JSON.parse(saves[0][1].body).expectedTotal).toBe(195);
  expect(JSON.parse(saves[1][1].body).expectedTotal).toBe(200);
});

// P2 (:4994): under the round-13 visit lock the pickers were disabled but
// each add-on's Remove button stayed active — removing a discounted row
// requests canonical adoption, which the PUT deterministically refuses
// with LEGACY_PRIMARY_GROSS_UNKNOWN.
it('round 23 (:4994): gate ON, the legacy visit lock also disables Remove on an add-on that carries a stored discount', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: legacyAddonDiscountVisit }));
  render(<Harness service={legacyAddonDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeDisabled());
  const remove = screen.getByRole('button', { name: 'Remove' });
  expect(remove).toBeDisabled();
  expect(remove).toHaveAttribute('title', expect.stringContaining('legacy discount'));
  fireEvent.click(remove);
  // The row is still there — nothing could queue a refused removal.
  expect(screen.getByText(/Discount can't be changed on this legacy line/)).toBeInTheDocument();
});

it('round 23 (:4994): the same lock leaves Remove ENABLED on an add-on with no stored discount (deleting it is not a term change)', async () => {
  const lockedWithPlainAddon = {
    ...legacyAddonDiscountVisit,
    serviceAddons: [
      ...legacyAddonDiscountVisit.serviceAddons,
      { id: 'addon-2', serviceId: 'svc-fert', serviceName: 'Quarterly Fertilization', serviceKey: 'lawn_fert', serviceCategory: 'lawn', basePrice: 40, estimatedPrice: 40, estimatedDuration: 20 },
    ],
  };
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: true, service: lockedWithPlainAddon }));
  render(<Harness service={lockedWithPlainAddon} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitFor(() => expect(apptDiscountSelect()).toBeDisabled());
  const removes = screen.getAllByRole('button', { name: 'Remove' });
  expect(removes).toHaveLength(2);
  expect(removes[0]).toBeDisabled();
  expect(removes[1]).toBeEnabled();
});

it('round 23 (:4994) gate-off parity: Remove stays enabled on the discounted legacy add-on', async () => {
  vi.stubGlobal('fetch', mockFetch({ stackingEnabled: false, service: legacyAddonDiscountVisit }));
  render(<Harness service={legacyAddonDiscountVisit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  await waitForMoneyReady();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
});
