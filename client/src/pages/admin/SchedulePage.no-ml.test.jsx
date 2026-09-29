// @vitest-environment jsdom
//
// Owner ruling (2026-09-27, every service 2026-09-29): nothing a tech sees or
// enters on a completion is in mL. The catalog keeps a label's own mL figure
// (the Arborjet "ml/inch dbh" injectables, SUPERthrive and Kelp's "ml/gal");
// the Complete Service form (CompletionPanel, desktop and phone layouts)
// never offers or prefills it, measures a small liquid in tsp (6 to the
// fl oz), and sends that as fl oz because the server's unit list has no tsp.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, catalogUnitOption, treeShrubCloseoutBlocksClient } from './SchedulePage';
import { isMlUnit } from '../../lib/measure-units';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

// The catalog's mL-label rows, as 20260816000010 wrote their display fields,
// and an ordinary per-basis label whose own unit must still render.
const IMA_JET = {
  id: 'ima-jet-10', name: 'Arborjet Ima-Jet 10', category: 'insecticide',
  default_rate: '1-6', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const SUPERTHRIVE = {
  id: 'superthrive', name: 'SUPERthrive Foliage-Pro 9-3-6', category: 'fertilizer',
  default_rate: '1.25-5', default_unit: 'ml/gal',
};
const KELP = { id: 'clean-kelp', name: 'Bloom City Clean Kelp', default_rate: '5-10', default_unit: 'ml/gal' };
const CONCENTRATE = {
  id: 'foliar-concentrate', name: 'Fixture foliar concentrate', category: 'insecticide',
  default_rate: '4-8', default_unit: 'fl_oz/100gal',
};
const GEL = { id: 'gel-bait', name: 'Fixture gel bait', category: 'bait', default_rate: '0.1-0.5', default_unit: 'g/spot' };
// A dry granule: weighed, never spooned.
const GRANULE = {
  id: 'granule', name: 'Fixture granular insecticide', category: 'insecticide', formulation: 'granular',
  default_rate: '1.5-2.3', default_unit: 'lb/1000 sq ft',
};
// A second product on the same tank (per gallon, in fl oz).
const PARTNER = {
  id: 'tank-partner', name: 'Fixture tank partner', category: 'insecticide',
  application_method: 'spot_treatment', default_rate: '0.5', default_unit: 'fl_oz/gal',
};
// A per-1,000 lawn row whose catalog rate unit and ceiling are in mL.
const LIQUID_KELP = {
  id: 'liquid-kelp', name: 'Example Liquid Kelp', category: 'fertilizer',
  rate_unit: 'ml', default_rate_per_1000: '30', max_label_rate_per_1000: '60',
};

const SHRUB_VISIT = {
  id: 'units-shrub-visit', customerId: 'units-customer', customerName: 'Synthetic Customer',
  serviceType: 'Tree & Shrub Care', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 90,
  completionProfile: { serviceKey: 'tree_shrub', requiresProducts: true },
};
const PEST_VISIT = {
  id: 'units-pest-visit', customerId: 'units-customer', customerName: 'Synthetic Customer',
  serviceType: 'Quarterly Pest Control Service', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
// A WaveGuard member's lawn visit: its closeout shows the label rate reviews.
const WAVEGUARD_LAWN_VISIT = {
  id: 'units-lawn-visit', customerId: 'units-customer', customerName: 'Synthetic Customer',
  serviceType: 'Every 6 Weeks Lawn Care Service', status: 'on_site', scheduledDate: '2099-01-01', estimatedPrice: 90,
  waveguardTier: 'Silver', completionProfile: { serviceKey: 'lawn', requiresProducts: true },
};

const LAYOUTS = [['desktop', 1024], ['phone', 390]];

function setWidth(width) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

async function mount(service, catalog, onSubmit = vi.fn().mockResolvedValue({})) {
  await act(async () => {
    render(<CompletionPanel service={service} products={catalog} onClose={() => {}} onSubmit={onSubmit} />);
  });
  return onSubmit;
}

// Also proves which layout rendered: the phone search box ends in "…".
const searchBox = () => screen.getByPlaceholderText(window.innerWidth < 640 ? 'Search products…' : 'Search products...');

async function pick(product) {
  fireEvent.change(searchBox(), { target: { value: product.name } });
  fireEvent.click(await screen.findByText(product.name));
}

// Each product row is Rate, rate unit, [gallons], Total, amount unit — the
// unit select is the next select after its input in both layouts.
function selectAfter(input) {
  let el = input.nextElementSibling;
  while (el && el.tagName !== 'SELECT') el = el.nextElementSibling;
  return el;
}
function rows() {
  const rates = screen.getAllByPlaceholderText('Rate');
  return screen.getAllByPlaceholderText('Total').map((total, i) => ({
    rate: rates[i],
    rateUnit: selectAfter(rates[i]),
    total,
    amountUnit: selectAfter(total),
  }));
}
const optionValues = (select) => [...select.options].map((option) => option.value);

// Every option on the form (the product rows and the rest of the closeout).
function mlOptions() {
  return [...document.querySelectorAll('option')]
    .filter((option) => isMlUnit(option.value) || /\b(ml|millilit(er|re)s?)\b/i.test(option.textContent))
    .map((option) => `${option.value} | ${option.textContent}`);
}

// Every string in the /complete body that is an mL unit.
function mlStrings(value, path = 'body') {
  if (typeof value === 'string') return isMlUnit(value) ? [`${path}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => mlStrings(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => mlStrings(item, `${path}.${key}`));
  }
  return [];
}

const submitButton = () => screen.getAllByRole('button', { name: /^Complete (& Send (Recap|Invoice)|Service)/i }).at(-1);

beforeEach(() => {
  localStorage.clear();
  setWidth(1024);
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  setWidth(1024);
});

describe('catalogUnitOption', () => {
  it('never renders an mL unit, even one outside the standard list', () => {
    const standard = ['tsp', 'oz', 'fl_oz', 'g', 'lb', 'gal'];
    expect(catalogUnitOption('ml/gal', standard)).toBeNull();
    expect(catalogUnitOption('ml', standard)).toBeNull();
    expect(catalogUnitOption('ml/inch dbh', standard)).toBeNull();
    expect(catalogUnitOption('mL/palm', standard)).toBeNull();
    // A label's own non-mL unit still renders.
    expect(catalogUnitOption('fl_oz/100gal', standard).props.value).toBe('fl_oz/100gal');
  });
});

describe.each(LAYOUTS)('Complete Service form, %s layout', (_layout, width) => {
  it('offers no mL unit anywhere, tsp for amounts, and starts an mL-label product blank in fl oz', async () => {
    setWidth(width);
    await mount(SHRUB_VISIT, [IMA_JET, SUPERTHRIVE, KELP, CONCENTRATE]);
    for (const product of [IMA_JET, SUPERTHRIVE, KELP, CONCENTRATE]) await pick(product);
    await waitFor(() => expect(rows()).toHaveLength(4));
    const [imaJet, superthrive, kelp, concentrate] = rows();

    for (const row of [imaJet, superthrive, kelp]) {
      expect(row.rate.value).toBe('');
      expect(row.rateUnit.value).toBe('');
      expect(row.total.value).toBe('');
      expect(row.amountUnit.value).toBe('fl_oz');
    }
    // An ordinary label keeps its own rate and unit.
    expect(concentrate.rate.value).toBe('4');
    expect(concentrate.rateUnit.value).toBe('fl_oz/100gal');
    expect(concentrate.amountUnit.value).toBe('fl_oz');

    for (const row of rows()) {
      expect(optionValues(row.amountUnit)).toContain('tsp');
      expect(optionValues(row.rateUnit)).not.toContain('tsp');
      expect(row.total.parentElement.textContent).not.toMatch(/\bml\b/i);
    }
    expect(mlOptions()).toEqual([]);
    // The injection record's dose is a number of tsp or fl oz.
    expect([...screen.getByLabelText('Dose unit').options].map((option) => option.value)).toEqual(['tsp', 'fl_oz']);
  });

  it('offers tsp only for a liquid, never a granule or gel bait', async () => {
    setWidth(width);
    await mount(PEST_VISIT, [SUPERTHRIVE, GEL, GRANULE]);
    for (const product of [SUPERTHRIVE, GEL, GRANULE]) await pick(product);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [superthrive, gel, granule] = rows();
    expect(optionValues(superthrive.amountUnit)).toContain('tsp');
    expect(optionValues(gel.amountUnit)).not.toContain('tsp');
    expect(optionValues(granule.amountUnit)).not.toContain('tsp');
    // The dry rows keep their weights.
    expect(optionValues(granule.amountUnit)).toEqual(expect.arrayContaining(['oz', 'g', 'lb']));
  });

  it('sends a tsp amount as fl oz and every other amount as entered', async () => {
    setWidth(width);
    const onSubmit = await mount(PEST_VISIT, [SUPERTHRIVE, GEL]);
    await pick(SUPERTHRIVE);
    await pick(GEL);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [superthrive, gel] = rows();
    expect(superthrive.rate.value).toBe('');
    expect(superthrive.amountUnit.value).toBe('fl_oz');

    fireEvent.change(superthrive.amountUnit, { target: { value: 'tsp' } });
    fireEvent.change(superthrive.total, { target: { value: '2' } });
    fireEvent.change(gel.total, { target: { value: '3' } });
    expect(rows()[0].amountUnit.value).toBe('tsp');
    expect(rows()[0].total.value).toBe('2');

    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    // 2 tsp is 1/3 fl oz, rounded up to the three decimals the record keeps.
    expect(body.products[0]).toMatchObject({
      productId: SUPERTHRIVE.id, rate: '', rateUnit: '', totalAmount: 0.334, amountUnit: 'fl_oz',
    });
    expect(body.products[1]).toMatchObject({
      productId: GEL.id, rate: 0.1, rateUnit: 'g/spot', totalAmount: '3', amountUnit: 'g',
    });
    expect(mlStrings(body)).toEqual([]);
  });

  it('restores a draft saved with mL in fl oz, with the mL rate withdrawn', async () => {
    setWidth(width);
    localStorage.setItem(`waves_completion_draft_${PEST_VISIT.id}`, JSON.stringify({
      serviceId: PEST_VISIT.id,
      savedAt: new Date().toISOString(),
      notes: 'Draft saved while the form offered mL',
      selectedProducts: [
        {
          productId: KELP.id, name: KELP.name, rate: 5, rateUnit: 'ml/gal', catalogRateUnit: 'ml/gal',
          maxLabelRatePer1000: 10, totalAmount: 30, amountUnit: 'ml', carrierGallons: 6, carrierGallonsManual: true,
          tankOwner: true, applicationMethod: 'broadcast_spray', applicationArea: '', areaValue: '', areaUnit: '', targets: [],
        },
        {
          productId: GEL.id, name: GEL.name, rate: 0.2, rateUnit: 'g/spot', catalogRateUnit: 'g/spot',
          maxLabelRatePer1000: 0.5, totalAmount: 3, amountUnit: 'g', applicationMethod: 'bait_placement',
          applicationArea: '', areaValue: '', areaUnit: '', targets: [],
        },
      ],
    }));
    const onSubmit = await mount(PEST_VISIT, [KELP, GEL]);
    expect(searchBox()).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [kelp, gel] = rows();

    // 30 mL is 1.014 fl oz; the mL rate and its tank go, for the tech to enter.
    expect(kelp.total.value).toBe('1.014');
    expect(kelp.amountUnit.value).toBe('fl_oz');
    expect(kelp.rate.value).toBe('');
    expect(kelp.rateUnit.value).toBe('');
    expect(screen.queryAllByPlaceholderText('Gal')).toHaveLength(0);
    // Any other row comes back exactly as saved.
    expect(gel.rate.value).toBe('0.2');
    expect(gel.rateUnit.value).toBe('g/spot');
    expect(gel.total.value).toBe('3');
    expect(gel.amountUnit.value).toBe('g');
    expect(mlOptions()).toEqual([]);

    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products[0]).toMatchObject({
      productId: KELP.id, rate: '', rateUnit: '', totalAmount: 1.014, amountUnit: 'fl_oz',
    });
    expect(body.products[1]).toMatchObject({
      productId: GEL.id, rate: 0.2, rateUnit: 'g/spot', totalAmount: 3, amountUnit: 'g',
    });
    expect(mlStrings(body)).toEqual([]);
  });
});

// The injection record's dose is free text, so the closeout check refuses one
// written in mL (the client mirror of tree-shrub-closeout.js on the server).
describe('the Tree & Shrub injection dose', () => {
  const doseBlocks = (dose) => treeShrubCloseoutBlocksClient({
    closeout: {
      injectionPerformed: true,
      injectionRecord: {
        plantSpecies: 'Sabal palm', sizeClassOrDbh: '12 in DBH', product: 'Palm-Jet Mg', dose,
        numberOfPorts: 4, targetIssue: 'Magnesium deficiency', followUpDate: '2099-02-01',
      },
    },
    productFlags: { missingActuals: [] },
    servicePhotos: [], service: {}, customerRecap: '', notes: '', isIncompleteVisit: false,
  }).filter((block) => block.field === 'injectionRecord.dose').map((block) => block.message);

  it('is refused in mL and taken in tsp or fl oz', () => {
    for (const dose of ['20 mL', '20ml', '5 cc', '2 milliliters']) {
      expect(doseBlocks(dose)).toEqual(['Injection dose must be in tsp or fl oz, not mL.']);
    }
    for (const dose of ['½ fl oz', '4 tsp']) expect(doseBlocks(dose)).toEqual([]);
    expect(doseBlocks('')).toEqual(['Injection record requires dose.']);
    // A saved dose that is not a number of tsp or fl oz is entered again.
    expect(doseBlocks('a squirt')).toEqual(['Enter the injection dose as a number of tsp or fl oz.']);
    // A dose left mid-entry, or zero, is not a dose.
    expect(doseBlocks('. fl oz')).toEqual(['Enter the injection dose as a number of tsp or fl oz.']);
    expect(doseBlocks('0 tsp')).toEqual(['Enter the injection dose as a number of tsp or fl oz.']);
    expect(doseBlocks('.5 tsp')).toEqual([]);
  });
});

describe('an mL label on a row the tech set in another unit', () => {
  // Only the mL goes: the label unit and its ceiling. The tech's own rate,
  // gallons and tank ownership stay, so a later gallons edit on another row
  // cannot blank this row's dose.
  it('restores the tech\'s own rate and tank, and the pest house 4 oz, without the mL label unit', async () => {
    localStorage.setItem(`waves_completion_draft_${PEST_VISIT.id}`, JSON.stringify({
      serviceId: PEST_VISIT.id,
      savedAt: new Date().toISOString(),
      notes: 'Draft saved while the form offered mL',
      selectedProducts: [
        {
          productId: SUPERTHRIVE.id, name: SUPERTHRIVE.name, rate: 0.17, rateUnit: 'fl_oz/gal', catalogRateUnit: 'ml/gal',
          maxLabelRatePer1000: 5, totalAmount: 0.34, totalAmountManual: false, amountUnit: 'fl_oz',
          carrierGallons: '2', carrierGallonsManual: true, tankOwner: true,
          applicationMethod: 'broadcast_spray', applicationArea: '', areaValue: '', areaUnit: '', targets: [],
        },
        {
          productId: PARTNER.id, name: PARTNER.name, rate: 0.5, rateUnit: 'fl_oz/gal', catalogRateUnit: 'fl_oz/gal',
          maxLabelRatePer1000: 0.5, totalAmount: 1, totalAmountManual: false, amountUnit: 'fl_oz',
          carrierGallons: '2', carrierGallonsManual: false, tankOwner: false,
          applicationMethod: 'spot_treatment', applicationArea: '', areaValue: '', areaUnit: '', targets: [],
        },
        {
          productId: KELP.id, name: KELP.name, rate: 4, rateUnit: 'oz', catalogRateUnit: 'ml/gal',
          maxLabelRatePer1000: 10, totalAmount: 4, totalAmountManual: true, amountUnit: 'oz',
          applicationMethod: 'perimeter_spray', applicationArea: '', areaValue: 100, areaUnit: 'linear_ft', targets: [],
        },
      ],
    }));
    const onSubmit = await mount(PEST_VISIT, [SUPERTHRIVE, PARTNER, KELP]);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [superthrive, , kelp] = rows();
    expect(superthrive.rate.value).toBe('0.17');
    expect(superthrive.rateUnit.value).toBe('fl_oz/gal');
    expect(superthrive.total.value).toBe('0.34');
    expect(kelp.rate.value).toBe('4');
    expect(kelp.rateUnit.value).toBe('oz');
    const gallons = () => screen.getAllByPlaceholderText('Gal');
    expect(gallons().map((input) => input.value)).toEqual(['2', '2']);

    // The partner goes on its own 3 gallons; this row keeps its 0.34 fl oz.
    fireEvent.change(gallons()[1], { target: { value: '3' } });
    expect(rows()[1].total.value).toBe('1.5');
    expect(rows()[0].total.value).toBe('0.34');
    expect(mlOptions()).toEqual([]);

    await act(async () => { fireEvent.click(submitButton()); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0][1];
    expect(body.products).toMatchObject([
      { productId: SUPERTHRIVE.id, rate: 0.17, rateUnit: 'fl_oz/gal', totalAmount: 0.34, amountUnit: 'fl_oz' },
      { productId: PARTNER.id, rate: 0.5, rateUnit: 'fl_oz/gal', totalAmount: 1.5, amountUnit: 'fl_oz' },
      { productId: KELP.id, rate: 4, rateUnit: 'oz', totalAmount: 4, amountUnit: 'oz' },
    ]);
    expect(mlStrings(body)).toEqual([]);
  });

  // buildSelectedProduct keeps no mL label unit or ceiling: the WaveGuard
  // rate reviews compare a rate against both, and would name the mL.
  it('names no mL label unit in a WaveGuard lawn rate review', async () => {
    await mount(WAVEGUARD_LAWN_VISIT, [LIQUID_KELP]);
    await pick(LIQUID_KELP);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].rate.value).toBe('');
    expect(rows()[0].rateUnit.value).toBe('');
    fireEvent.change(rows()[0].rate, { target: { value: '1' } });
    fireEvent.change(rows()[0].rateUnit, { target: { value: 'fl_oz' } });
    expect(rows()[0].rateUnit.value).toBe('fl_oz');
    expect(document.body.textContent).not.toMatch(/label unit|label max/i);
    expect(document.body.textContent).not.toMatch(/\b(ml|millilit(er|re)s?)\b/i);
  });
});
