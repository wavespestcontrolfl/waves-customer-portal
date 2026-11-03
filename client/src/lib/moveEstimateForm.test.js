// New-home estimate seed (Moving PR B1): what carries over from the old
// estimate, what is forced off, and what starts clean.
import { describe, expect, it } from 'vitest';
import { MOVE_KEPT_SERVICE_FLAGS, formatCalendarDate, moveEstimateForm } from './moveEstimateForm';

const base = {
  leadId: '', customerId: '', address: '', customerName: '', customerPhone: '', customerEmail: '',
  leadServiceInterest: '', notes: '', homeSqFt: '', lotSqFt: '', isRecurringCustomer: 'NO',
  manualDiscountPreset: '', manualDiscountType: 'NONE', manualDiscountValue: '', manualDiscountLabel: '',
  manualDiscountInternalReason: '', serviceSpecificDiscountKeys: [], linePriceOverrides: {},
  roachFeeOverride: '', standaloneRoachFeeOverride: '', showOneTimeOption: false, billByInvoice: false,
  offerTiers: false, _offerTiersDeclined: false, tierExtensionPick: null,
  lawnFreq: '9', pestFreq: '4', tsTier: 'standard', mosquitoProgram: 'standard',
  roachModifier: 'NONE', mosquitoStationCount: '', mosquitoDunkCount: '', palmCustomPricePerPalm: '', grassType: 'st_augustine',
  svcLawn: false, svcPest: false, svcTs: false, svcInjection: false, svcMosquito: false, svcRodentBait: false,
  svcTermiteBait: false, svcFoamRecurring: false, svcMisting: false, svcOnetimePest: false, svcWdo: false,
  mistingTier: '', mistingRefillsPerYear: '4',
};
const clearedProperty = { homeSqFt: '', lotSqFt: '', propertyId: '', _manualFields: [], _unitCountEdited: false };

const data = {
  move: { id: 'm1', address: '123 Palm Ave, Venice, FL 34285', moveOutDate: '2026-11-15', moveInDate: '2026-11-20' },
  customer: { id: 'c1', name: 'Pat Example', phone: '+19415550100', email: 'pat@example.com' },
  isRecurringCustomer: true,
  source: {
    estimateId: 'e1',
    inputs: {
      svcLawn: true, svcPest: true, svcTs: true, svcInjection: true, svcMosquito: true, svcRodentBait: true,
      svcTermiteBait: true, svcFoamRecurring: true, svcMisting: true, svcOnetimePest: true, svcWdo: true,
      mistingTier: 'premium', mistingRefillsPerYear: '6',
      homeSqFt: '2400', lotSqFt: '9000', propertyId: 'p-old', _homeSqFtEdited: true,
      lawnFreq: '12', pestFreq: '6',
      manualDiscountPreset: 'multi_home', manualDiscountType: 'PERCENT', manualDiscountValue: '10', manualDiscountLabel: 'Multi-Home Discount',
      serviceSpecificDiscountKeys: ['x'], linePriceOverrides: { lawn: { price: 50 } },
      roachFeeOverride: '40', standaloneRoachFeeOverride: '30',
      showOneTimeOption: true, billByInvoice: true, notes: 'gate code', leadId: 'lead-1', offerTiers: true,
      tsTier: 'light4', mosquitoProgram: 'monthly12',
      // Old-house treatment facts and overrides (codex #7532 r1).
      roachModifier: 'GERMAN', mosquitoStationCount: '8', mosquitoDunkCount: '4', palmCustomPricePerPalm: '45',
      grassType: 'zoysia', someRetiredBuilderField: 'old',
    },
  },
};

describe('moveEstimateForm', () => {
  it('keeps only the five recurring service flags and forces every other svc flag off', () => {
    const { form } = moveEstimateForm(data, { base, clearedProperty });
    expect(MOVE_KEPT_SERVICE_FLAGS).toEqual(['svcLawn', 'svcPest', 'svcTs', 'svcMosquito', 'svcRodentBait']);
    for (const key of MOVE_KEPT_SERVICE_FLAGS) expect(form[key]).toBe(true);
    // Palm injection stays off: a one-time palm treatment must not become a paid recurring program (codex #7532 r3).
    for (const key of ['svcInjection', 'svcTermiteBait', 'svcFoamRecurring', 'svcMisting', 'svcOnetimePest', 'svcWdo']) expect(form[key]).toBe(false);
    expect(form.mistingTier).toBe('');
    expect(form.mistingRefillsPerYear).toBe('4');
    // Cadence for the kept services still copies; a retired T&S program opens standard.
    expect(form.lawnFreq).toBe('12');
    expect(form.pestFreq).toBe('6');
    expect(form.tsTier).toBe('standard');
    expect(form.mosquitoProgram).toBe('monthly12');
  });

  it('carries only each kept service\'s schedule: old-house treatment facts and overrides start from the defaults', () => {
    const { form } = moveEstimateForm(data, { base, clearedProperty });
    // A carried roach condition would make Generate add a paid one-time knockdown.
    expect(form.roachModifier).toBe('NONE');
    expect(form.mosquitoStationCount).toBe('');
    expect(form.mosquitoDunkCount).toBe('');
    expect(form.palmCustomPricePerPalm).toBe('');
    expect(form.grassType).toBe('st_augustine');
    expect(form).not.toHaveProperty('someRetiredBuilderField');
  });

  it('clears property fields, discounts, overrides and delivery choices', () => {
    const { form, droppedDiscountLabel } = moveEstimateForm(data, { base, clearedProperty });
    expect(form.homeSqFt).toBe('');
    expect(form.lotSqFt).toBe('');
    expect(form.propertyId).toBe('');
    expect(form._homeSqFtEdited).toBeUndefined();
    expect(form.manualDiscountPreset).toBe('');
    expect(form.manualDiscountType).toBe('NONE');
    expect(form.manualDiscountValue).toBe('');
    expect(form.manualDiscountLabel).toBe('');
    expect(form.serviceSpecificDiscountKeys).toEqual([]);
    expect(form.linePriceOverrides).toEqual({});
    expect(form.roachFeeOverride).toBe('');
    expect(form.standaloneRoachFeeOverride).toBe('');
    expect(form.showOneTimeOption).toBe(false);
    expect(form.billByInvoice).toBe(false);
    expect(form.offerTiers).toBe(false);
    expect(form.notes).toBe('');
    expect(form.leadId).toBe('');
    expect(droppedDiscountLabel).toBe('Multi-Home Discount');
  });

  it('sets the customer, the new address and the recurring flag', () => {
    const { form } = moveEstimateForm(data, { base, clearedProperty });
    expect(form).toMatchObject({
      customerId: 'c1', customerName: 'Pat Example', customerPhone: '+19415550100', customerEmail: 'pat@example.com',
      address: '123 Palm Ave, Venice, FL 34285', isRecurringCustomer: 'YES',
    });
    expect(form.groupAnchorId).toBeUndefined();
  });

  it('with no source estimate gives the default form plus address and customer', () => {
    const { form, droppedDiscountLabel } = moveEstimateForm({ ...data, source: null, isRecurringCustomer: false }, { base, clearedProperty });
    expect(form).toMatchObject({
      ...base, ...clearedProperty,
      customerId: 'c1', customerName: 'Pat Example', customerPhone: '+19415550100', customerEmail: 'pat@example.com',
      address: '123 Palm Ave, Venice, FL 34285', isRecurringCustomer: 'NO',
    });
    expect(form.svcLawn).toBe(false);
    expect(droppedDiscountLabel).toBe('');
  });

  it('says there was no dropped discount when the old estimate had none', () => {
    const plain = { ...data, source: { estimateId: 'e1', inputs: { svcLawn: true, manualDiscountType: 'NONE' } } };
    expect(moveEstimateForm(plain, { base, clearedProperty }).droppedDiscountLabel).toBe('');
  });
});

describe('formatCalendarDate', () => {
  it('reads YYYY-MM-DD as a calendar date, with no time-zone shift', () => {
    expect(formatCalendarDate('2026-11-14')).toBe('Nov 14, 2026');
    expect(formatCalendarDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatCalendarDate('2026-12-31T00:00:00.000Z')).toBe('Dec 31, 2026');
    expect(formatCalendarDate(null)).toBe('');
    expect(formatCalendarDate('soon')).toBe('');
  });
});
