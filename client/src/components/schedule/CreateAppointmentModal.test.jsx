import { describe, expect, it, vi } from 'vitest';
import {
  assertManualPrepayMintEligible,
  bookableProperties,
  bookingLogisticsFields,
  bookingPropertyTarget,
  boosterMonthsForGroup,
  buildFindTimeRequestBody,
  canSubmitAppointments,
  classifyManualPrepayMintOutcome,
  classifySubmitGroupFailure,
  composeAppointmentSuccessToast,
  customerPropertyCountLabel,
  decideAnnualPrepayAttachment,
  defaultBookingPropertyId,
  duplicateProgramOverrideFields,
  ESTIMATE_SOURCE_LABEL,
  filterScheduleEstimatesForProperty,
  findScheduleEstimateById,
  firstGroupSendFlags,
  isBookableProperty,
  matchesPrepayTarget,
  formatScheduleEstimateAmount,
  mosquitoQuotePendingOutcome,
  mosquitoRevalidationOutcome,
  mosquitoSubmitGate,
  MANUAL_SERVICE_ENTRY_LABEL,
  pickAutoScheduleEstimate,
  prepaidFields,
  primaryLineRequestFields,
  quickAddConfirmFlags,
  quickAddConflictFromError,
  recurringScheduleFields,
  shouldMintManualPrepay,
  submitFailureNotice,
  technicianAssignmentFields,
} from './CreateAppointmentModal.jsx';

describe('CreateAppointmentModal won estimate helpers', () => {
  it('uses clear copy for manual appointment entry', () => {
    expect(ESTIMATE_SOURCE_LABEL).toBe('Estimate source');
    expect(MANUAL_SERVICE_ENTRY_LABEL).toBe('No estimate - choose services manually');
  });

  it('finds numeric estimate ids from select string values', () => {
    const estimates = [{ id: 42 }, { id: 108 }];

    expect(findScheduleEstimateById(estimates, '108')).toEqual({ id: 108 });
  });

  it('keeps cents in won estimate amounts', () => {
    expect(formatScheduleEstimateAmount({ onetimeTotal: 94.08 })).toBe('$94.08 one-time');
    expect(formatScheduleEstimateAmount({ monthlyTotal: '94.08' })).toBe('$94.08/mo');
  });

  it('recurring quotes read per-application, never a normalized monthly (owner ruling 2026-08-02)', () => {
    // Real quote line → per-application framing, with the one-time setup split out.
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 36.30,
      onetimeTotal: 99,
      lines: [{ cadence: 'quarterly', price: 121, perApplicationPrice: 121 }],
    })).toBe('$121.00/application + $99.00 one-time');
    // Multiple recurring lines join without summing across cadences.
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 116.55,
      lines: [{ cadence: 'monthly', price: 114, perApplicationPrice: 114 }, { cadence: 'quarterly', price: 132, perApplicationPrice: 132 }],
    })).toBe('$114.00 + $132.00/application');
    // A line without explicit per-application provenance (synthesized
    // monthly fallback, genuinely monthly-billed plan, list-only data)
    // keeps the legacy /mo copy — the server only stamps
    // perApplicationPrice via the canonical discount-aware derivation.
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 24,
      lines: [{ cadence: 'quarterly', price: 24, derived: 'estimate_totals_fallback' }],
    })).toBe('$24.00/mo');
    // A MIXED quote keeps EACH billing unit — collapsing to one aggregate
    // monthly is the exact flat-monthly copy this removes (Codex #3173 r2).
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 64.33,
      lines: [
        { cadence: 'quarterly', price: 121, perApplicationPrice: 121 },
        { cadence: 'monthly', price: 24, monthlyPrice: 24, derived: 'estimate_totals_fallback' },
      ],
    })).toBe('$121.00/application + $24.00/mo');
    // A mixed quote whose monthly line has NO proven unit at all falls back
    // to the legacy aggregate — never a partial label.
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 64.33,
      lines: [
        { cadence: 'quarterly', price: 121, perApplicationPrice: 121 },
        { cadence: 'monthly', price: 24 },
      ],
    })).toBe('$64.33/mo');
    // An ALL-monthly proven set (rodent-bait-only quote) still renders its
    // unit — and keeps the recurring charge next to one-time work.
    expect(formatScheduleEstimateAmount({
      monthlyTotal: 39,
      onetimeTotal: 250,
      lines: [{ cadence: 'quarterly', price: 117, monthlyPrice: 39 }],
    })).toBe('$39.00/mo + $250.00 one-time');
  });

  it('auto-selects exactly one unlinked accepted estimate for an empty schedule form', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [{ id: 108, status: 'accepted', linkedAppointment: false }],
    })).toEqual({
      estimate: { id: 108, status: 'accepted', linkedAppointment: false },
      key: '7:108',
    });
  });

  it('does not auto-select an open (sent/viewed) quote — it must be picked deliberately', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [{ id: 108, status: 'sent', linkedAppointment: false }],
    })).toBeNull();
  });

  it('does not auto-select when there are multiple unlinked accepted estimates', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [
        { id: 108, status: 'accepted', linkedAppointment: false },
        { id: 109, status: 'accepted', linkedAppointment: false },
      ],
    })).toBeNull();
  });

  it('does not auto-select the same accepted estimate twice', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [{ id: 108, status: 'accepted', linkedAppointment: false }],
      appliedKey: '7:108',
    })).toBeNull();
  });
});

describe('buildFindTimeRequestBody', () => {
  it('never sends the catalog service id as serviceId (server reads it as a visit id → 404)', () => {
    const body = buildFindTimeRequestBody({
      customerId: 'cust-1',
      serviceName: 'Quarterly Pest',
      durationMinutes: 60,
      dateFrom: '2026-08-24',
      dateTo: '2026-08-31',
      technicianId: undefined,
      horizonDays: 7,
    });
    expect(body).not.toHaveProperty('serviceId');
    // No property chosen → no address override; the server resolves the primary.
    expect(body.address).toBeUndefined();
    expect(body.lat).toBeUndefined();
    expect(body).toMatchObject({
      customerId: 'cust-1',
      serviceType: 'Quarterly Pest',
      durationMinutes: 60,
      dateFrom: '2026-08-24',
      dateTo: '2026-08-31',
      topN: 25,
    });
    expect(body.technicianId).toBeUndefined();
  });

  it('widens topN for long horizons and passes a chosen technician', () => {
    const body = buildFindTimeRequestBody({ customerId: 'c', serviceName: 's', durationMinutes: 90, dateFrom: 'a', dateTo: 'b', technicianId: 'tech-9', horizonDays: 30 });
    expect(body.topN).toBe(100);
    expect(body.technicianId).toBe('tech-9');
  });
});

describe('quick-add phone-match confirm helpers', () => {
  const err = (status, code, match) => Object.assign(new Error('x'), { status, code, details: match ? { match } : undefined });

  it('maps only the two 409 confirm codes to a conflict (other errors stay generic)', () => {
    expect(quickAddConflictFromError(null)).toBeNull();
    expect(quickAddConflictFromError(err(500, 'DUPLICATE_PROFILE'))).toBeNull();
    expect(quickAddConflictFromError(err(409, 'CUSTOMER_BUSY'))).toBeNull();
    const c = quickAddConflictFromError(err(409, 'PHONE_MATCH_CONFIRM', { accountId: 'acct-1', name: 'Existing Owner' }));
    expect(c).toMatchObject({ code: 'PHONE_MATCH_CONFIRM', match: { accountId: 'acct-1' } });
    // Missing match payload must not crash the confirm UI.
    expect(quickAddConflictFromError(err(409, 'DUPLICATE_PROFILE'))).toMatchObject({ code: 'DUPLICATE_PROFILE', match: null });
  });

  it('binds resubmit flags to the displayed account; separate-account uses the force lane', () => {
    expect(quickAddConfirmFlags({ code: 'PHONE_MATCH_CONFIRM', match: { accountId: 'acct-1' } }))
      .toEqual({ confirmAttach: true, confirmMatchedAccountId: 'acct-1' });
    expect(quickAddConfirmFlags({ code: 'DUPLICATE_PROFILE', match: { accountId: 'acct-1' } }))
      .toEqual({ confirmDuplicate: true, confirmMatchedAccountId: 'acct-1' });
    expect(quickAddConfirmFlags({ code: 'PHONE_MATCH_CONFIRM' }, { separateAccount: true }))
      .toEqual({ forceNewAccount: true, ignorePhoneMatch: true });
  });
});

describe('multi-property booking helpers', () => {
  const HOME = { id: 'p-home', is_primary: true, address_line1: '10 Palm Ave' };
  const RENTAL = { id: 'p-rental', is_primary: false, address_line1: '20 Oak St' };

  it('defaults the picker to the primary property, else the first, else nothing', () => {
    expect(defaultBookingPropertyId([RENTAL, HOME])).toBe('p-home');
    expect(defaultBookingPropertyId([RENTAL])).toBe('p-rental');
    expect(defaultBookingPropertyId([])).toBe('');
  });

  it('offers property-linked quotes only at their own property and unlinked quotes everywhere', () => {
    const forHome = { id: 1, propertyId: 'p-home' };
    const forRental = { id: 2, propertyId: 'p-rental' };
    const anywhere = { id: 3, propertyId: null };
    const all = [forHome, forRental, anywhere];
    expect(filterScheduleEstimatesForProperty(all, 'p-rental')).toEqual([forRental, anywhere]);
    expect(filterScheduleEstimatesForProperty(all, 'p-home')).toEqual([forHome, anywhere]);
    // No picker (single-property customer / lane dark) → nothing is hidden.
    expect(filterScheduleEstimatesForProperty(all, '')).toEqual(all);
  });
});

describe('service-address picker guards', () => {
  const COMPLETE = { id: 'p1', is_primary: true, address_line1: '10 Palm Ave', city: 'Naples', state: 'FL', zip: '34102', latitude: '27.4400000', longitude: '-82.5200000' };
  const STREET_ONLY = { id: 'p2', is_primary: false, address_line1: '20 Oak St', city: '', state: 'FL', zip: null };
  const RENTAL = { id: 'p3', is_primary: false, address_line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34103' };

  it('offers only properties with a complete street address (the server refuses the rest)', () => {
    expect(isBookableProperty(COMPLETE)).toBe(true);
    expect(isBookableProperty(STREET_ONLY)).toBe(false);
    expect(isBookableProperty(null)).toBe(false);
    expect(bookableProperties([COMPLETE, STREET_ONLY, RENTAL]).map((p) => p.id)).toEqual(['p1', 'p3']);
    // An incomplete PRIMARY never becomes the default either.
    expect(defaultBookingPropertyId(bookableProperties([{ ...COMPLETE, zip: '' }, RENTAL]))).toBe('p3');
  });

  it('routes slot searches to the chosen property: coords when present, else its address', () => {
    expect(bookingPropertyTarget(COMPLETE)).toEqual({ address: '10 Palm Ave, Naples, FL 34102', lat: 27.44, lng: -82.52 });
    expect(bookingPropertyTarget(RENTAL)).toEqual({ address: '20 Oak St, Naples, FL 34103', lat: undefined, lng: undefined });
    // Not-yet-geocoded rows carry NULL — never a 0,0 pair the server would trust.
    expect(bookingPropertyTarget({ ...RENTAL, latitude: null, longitude: null })).toMatchObject({ lat: undefined, lng: undefined });
    expect(bookingPropertyTarget({ ...RENTAL, latitude: '', longitude: '' })).toMatchObject({ lat: undefined, lng: undefined });
    // A half pair is no pair.
    expect(bookingPropertyTarget({ ...RENTAL, latitude: '26.1', longitude: null })).toMatchObject({ lat: undefined, lng: undefined });
    expect(bookingPropertyTarget(null)).toEqual({});
    const body = buildFindTimeRequestBody({ customerId: 'c', ...bookingPropertyTarget(COMPLETE), serviceName: 's', durationMinutes: 60, dateFrom: 'a', dateTo: 'b' });
    expect(body).toMatchObject({ customerId: 'c', lat: 27.44, lng: -82.52, address: '10 Palm Ave, Naples, FL 34102' });
  });
});

describe('customerPropertyCountLabel', () => {
  it('labels a customer with two or more active saved properties', () => {
    expect(customerPropertyCountLabel(2)).toBe('2 properties');
    expect(customerPropertyCountLabel('4')).toBe('4 properties');
  });

  it('stays silent for 0/1 properties and for a missing count', () => {
    expect(customerPropertyCountLabel(1)).toBeNull();
    expect(customerPropertyCountLabel(0)).toBeNull();
    expect(customerPropertyCountLabel(undefined)).toBeNull();
    expect(customerPropertyCountLabel(null)).toBeNull();
    expect(customerPropertyCountLabel('n/a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitAppointments helpers (structural lint follow-up — see AGENTS.md
// ~L396-400). Each covers one payload section or one decision the giant
// function used to inline.
// ---------------------------------------------------------------------------

describe('canSubmitAppointments', () => {
  it('requires a customer, at least one service, and a ready property picker', () => {
    expect(canSubmitAppointments({ selectedCustomer: { id: 1 }, services: [{}], bookingPropertyState: 'ready', alreadySubmitting: false })).toBe(true);
    expect(canSubmitAppointments({ selectedCustomer: null, services: [{}], bookingPropertyState: 'ready', alreadySubmitting: false })).toBe(false);
    expect(canSubmitAppointments({ selectedCustomer: { id: 1 }, services: [], bookingPropertyState: 'ready', alreadySubmitting: false })).toBe(false);
    expect(canSubmitAppointments({ selectedCustomer: { id: 1 }, services: [{}], bookingPropertyState: 'loading', alreadySubmitting: false })).toBe(false);
  });

  it('refuses a second concurrent submit regardless of the other conditions', () => {
    expect(canSubmitAppointments({ selectedCustomer: { id: 1 }, services: [{}], bookingPropertyState: 'ready', alreadySubmitting: true })).toBe(false);
  });
});

describe('mosquitoQuotePendingOutcome', () => {
  it('clears the cached quote and blames the failed fetch on error status', () => {
    expect(mosquitoQuotePendingOutcome({ status: 'error' })).toEqual({
      clearQuote: true,
      message: 'Mosquito price quote failed — retrying; submit again in a moment or enter a price',
    });
  });

  it('asks the operator to wait while a quote is still resolving', () => {
    expect(mosquitoQuotePendingOutcome({ status: 'loading' })).toEqual({
      clearQuote: false,
      message: 'Fetching the lot-based mosquito price — try again in a moment or enter a price',
    });
    expect(mosquitoQuotePendingOutcome(null)).toMatchObject({ clearQuote: false });
  });
});

describe('mosquitoRevalidationOutcome', () => {
  it('flags a changed price and carries the fresh numeric value', () => {
    expect(mosquitoRevalidationOutcome({ price: 42 }, { price: 30 })).toEqual({ changed: true, freshPrice: 42 });
  });

  it('reports unchanged when the fresh price matches the cached one', () => {
    expect(mosquitoRevalidationOutcome({ price: 30 }, { price: 30 })).toEqual({ changed: false, freshPrice: 30 });
  });

  it('treats a missing fresh price as null, never NaN or 0', () => {
    expect(mosquitoRevalidationOutcome({}, { price: 30 })).toEqual({ changed: true, freshPrice: null });
    // Both sides null-ish: freshPrice resolves to null, the cached side to
    // undefined (no quote object at all) — a strict !== still reads that as
    // changed, same as the original inline comparison.
    expect(mosquitoRevalidationOutcome(null, null)).toEqual({ changed: true, freshPrice: null });
  });

describe('mosquitoSubmitGate', () => {
  const base = { mosquitoQuote: { status: 'ready', price: 89 }, customerId: 'c-1' };
  it('holds a submit while the quote is still resolving, clearing only a failed quote', async () => {
    const fetchQuote = vi.fn();
    expect(await mosquitoSubmitGate({ ...base, quotePending: true, needsRevalidation: true, mosquitoQuote: { status: 'loading' }, fetchQuote }))
      .toMatchObject({ clearQuote: false, refresh: false, holdMs: 2800, message: /Fetching the lot-based mosquito price/ });
    expect(await mosquitoSubmitGate({ ...base, quotePending: true, needsRevalidation: true, mosquitoQuote: { status: 'error' }, fetchQuote }))
      .toMatchObject({ clearQuote: true, refresh: false, message: /quote failed/ });
    expect(fetchQuote).not.toHaveBeenCalled();
  });
  it('proceeds without a fetch when no auto-priced mosquito line is on the booking', async () => {
    const fetchQuote = vi.fn();
    expect(await mosquitoSubmitGate({ ...base, quotePending: false, needsRevalidation: false, fetchQuote })).toBeNull();
    expect(fetchQuote).not.toHaveBeenCalled();
  });
  it('proceeds when the re-verified price matches the cached quote', async () => {
    const fetchQuote = vi.fn(async () => ({ price: 89 }));
    expect(await mosquitoSubmitGate({ ...base, quotePending: false, needsRevalidation: true, fetchQuote })).toBeNull();
    expect(fetchQuote).toHaveBeenCalledWith('/admin/schedule/mosquito-onetime-quote?customerId=c-1');
  });
  it('holds with the refreshed price when the server now quotes differently, even a missing one', async () => {
    expect(await mosquitoSubmitGate({ ...base, quotePending: false, needsRevalidation: true, fetchQuote: async () => ({ price: '95' }) }))
      .toEqual({ message: expect.stringMatching(/price changed/), holdMs: 3200, clearQuote: false, refresh: true, price: 95 });
    expect(await mosquitoSubmitGate({ ...base, quotePending: false, needsRevalidation: true, fetchQuote: async () => ({}) }))
      .toMatchObject({ refresh: true, price: null });
  });
  it('clears the cached quote and holds when the re-verification fetch fails', async () => {
    expect(await mosquitoSubmitGate({ ...base, quotePending: false, needsRevalidation: true, fetchQuote: async () => { throw new Error('offline'); } }))
      .toMatchObject({ clearQuote: true, refresh: false, holdMs: 3200, message: /Could not re-verify/ });
  });
});
});

describe('classifySubmitGroupFailure', () => {
  const dupError = (existingSeries) => Object.assign(new Error('duplicate'), {
    body: { code: 'duplicate_recurring_series', existingSeries },
  });

  it('recovers silently when the conflict payload proves THIS group already exists', () => {
    const decision = classifySubmitGroupFailure(
      dupError([{ id: 's1', sourceEstimateId: 108 }]),
      { group: { seasonalIndex: 0 }, linkedEstimate: { id: 108 }, separateProgram: null, key: 'quarterly', groupLabelText: 'Quarterly' },
    );
    expect(decision).toEqual({ recoverable: true, duplicateConflict: null, firstError: null });
  });

  it('does not recover a same-family second seasonal sibling short of its own series', () => {
    // Only one owned series exists, but THIS group is the second seasonal
    // sibling (seasonalIndex 1) — the guard must not treat the first
    // sibling's series as proof of the second's (codex r26 P1).
    const decision = classifySubmitGroupFailure(
      dupError([{ id: 's1', sourceEstimateId: 108 }]),
      { group: { seasonalIndex: 1 }, linkedEstimate: { id: 108 }, separateProgram: null, key: 'seasonal_feb_oct:2', groupLabelText: 'Seasonal' },
    );
    expect(decision.recoverable).toBe(false);
    expect(decision.duplicateConflict).toMatchObject({ key: 'seasonal_feb_oct:2' });
  });

  it('never auto-recovers when the operator is mid explicit separate-program retry for this key', () => {
    const decision = classifySubmitGroupFailure(
      dupError([{ id: 's1', sourceEstimateId: 108 }]),
      {
        group: { seasonalIndex: 0 },
        linkedEstimate: { id: 108 },
        separateProgram: { key: 'quarterly', existingSeries: [{ id: 's1' }] },
        key: 'quarterly',
        groupLabelText: 'Quarterly',
      },
    );
    expect(decision.recoverable).toBe(false);
    expect(decision.duplicateConflict).toMatchObject({ retryUncertain: true });
  });

  it('surfaces a genuinely pre-existing program as the duplicate-conflict error, not a silent skip', () => {
    const decision = classifySubmitGroupFailure(
      dupError([{ id: 'other-series', sourceEstimateId: null }]),
      { group: { seasonalIndex: 0 }, linkedEstimate: { id: 108 }, separateProgram: null, key: 'quarterly', groupLabelText: 'Quarterly' },
    );
    expect(decision).toEqual({
      recoverable: false,
      duplicateConflict: { code: 'duplicate_recurring_series', existingSeries: [{ id: 'other-series', sourceEstimateId: null }], key: 'quarterly', retryUncertain: false },
      firstError: { label: 'Quarterly', message: 'duplicate', duplicate: true },
    });
  });

  it('classifies a non-duplicate error as a plain, non-recoverable failure', () => {
    const decision = classifySubmitGroupFailure(new Error('network down'), {
      group: { seasonalIndex: 0 }, linkedEstimate: null, separateProgram: null, key: 'weekly', groupLabelText: 'Weekly',
    });
    expect(decision).toEqual({
      recoverable: false,
      duplicateConflict: null,
      firstError: { label: 'Weekly', message: 'network down', duplicate: false },
    });
  });
});

describe('duplicateProgramOverrideFields', () => {
  it('carries the override only for the matching group key', () => {
    const separateProgram = { key: 'quarterly', existingSeries: [{ id: 's1' }, { id: 's2' }] };
    expect(duplicateProgramOverrideFields(separateProgram, 'quarterly', '  second program, different address  ')).toEqual({
      allowDuplicateSeries: true,
      duplicateSeriesOverride: { reason: 'second program, different address', existingSeriesIds: ['s1', 's2'] },
    });
    expect(duplicateProgramOverrideFields(separateProgram, 'monthly', 'x')).toEqual({});
    expect(duplicateProgramOverrideFields(null, 'quarterly', 'x')).toEqual({});
  });
});

describe('primaryLineRequestFields', () => {
  it('sends a blank-priced auto-mosquito primary as null regardless of groupHasPrice', () => {
    expect(primaryLineRequestFields({
      primaryId: 5, primaryIsBlankAutoMosquito: true, groupHasPrice: true, primaryBasePrice: 40, primaryDiscount: null, primaryDiscountDollars: 0,
    })).toMatchObject({ serviceId: 5, primaryLinePrice: null });
  });

  it('sends null price when the group carries no price at all', () => {
    expect(primaryLineRequestFields({
      primaryId: 5, primaryIsBlankAutoMosquito: false, groupHasPrice: false, primaryBasePrice: 40, primaryDiscount: null, primaryDiscountDollars: 0,
    })).toMatchObject({ primaryLinePrice: null });
  });

  it('sends the base price when the group has a price and the line is not blank auto-mosquito', () => {
    expect(primaryLineRequestFields({
      primaryId: 5, primaryIsBlankAutoMosquito: false, groupHasPrice: true, primaryBasePrice: 40, primaryDiscount: null, primaryDiscountDollars: 0,
    })).toMatchObject({ primaryLinePrice: 40 });
  });

  it('shapes the discount block only when a discount is attached', () => {
    expect(primaryLineRequestFields({
      primaryId: 5, primaryIsBlankAutoMosquito: false, groupHasPrice: true, primaryBasePrice: 40,
      primaryDiscount: { id: 'd1', name: '10% off', discount_type: 'percent', amount: 10 }, primaryDiscountDollars: 4,
    }).primaryLineDiscount).toEqual({ discountId: 'd1', discountName: '10% off', discountType: 'percent', discountAmount: 10, discountDollars: 4 });
    expect(primaryLineRequestFields({
      primaryId: 5, primaryIsBlankAutoMosquito: false, groupHasPrice: true, primaryBasePrice: 40, primaryDiscount: null, primaryDiscountDollars: 0,
    }).primaryLineDiscount).toBeUndefined();
  });
});

describe('technicianAssignmentFields', () => {
  it('sends the chosen tech only in choose mode', () => {
    expect(technicianAssignmentFields('choose', 'tech-9')).toEqual({ assignmentMode: 'choose', technicianId: 'tech-9' });
    expect(technicianAssignmentFields('auto', 'tech-9')).toEqual({ assignmentMode: 'auto', technicianId: undefined });
  });
});

describe('bookingLogisticsFields', () => {
  it('sends null estimated price when the group has none, and omits duration/property when absent', () => {
    expect(bookingLogisticsFields({
      groupHasPrice: false, groupSubtotal: 0, groupDuration: 0, linkedEstimate: null,
      propertyPickerActive: false, selectedPropertyId: '', customerNotes: '', internalNotes: '',
    })).toEqual({
      estimatedPrice: null, estimatedDuration: undefined, sourceEstimateId: undefined,
      propertyId: undefined, notes: undefined, internalNotes: undefined,
    });
  });

  it('sends the subtotal, duration, linked estimate id and chosen property when present', () => {
    expect(bookingLogisticsFields({
      groupHasPrice: true, groupSubtotal: 199, groupDuration: 45, linkedEstimate: { id: 'est-1' },
      propertyPickerActive: true, selectedPropertyId: 'p-2', customerNotes: 'gate code 1234', internalNotes: 'watch the dog',
    })).toEqual({
      estimatedPrice: 199, estimatedDuration: 45, sourceEstimateId: 'est-1',
      propertyId: 'p-2', notes: 'gate code 1234', internalNotes: 'watch the dog',
    });
  });

  it('never sends propertyId when the picker is inactive, even with a selected id', () => {
    expect(bookingLogisticsFields({
      groupHasPrice: true, groupSubtotal: 1, groupDuration: 1, linkedEstimate: null,
      propertyPickerActive: false, selectedPropertyId: 'p-2', customerNotes: '', internalNotes: '',
    }).propertyId).toBeUndefined();
  });
});

describe('firstGroupSendFlags', () => {
  it('sends the confirmation text and card link only for the first group of the booking', () => {
    expect(firstGroupSendFlags({ resultsCount: 0, createdCount: 0, sendSms: true, cardLinkAvailable: true, sendCardLink: true })).toEqual({
      sendConfirmationSms: true, sendConfirmation: true, sendCardOnFileLink: true,
    });
  });

  it('suppresses both for every later group in a split save', () => {
    expect(firstGroupSendFlags({ resultsCount: 1, createdCount: 0, sendSms: true, cardLinkAvailable: true, sendCardLink: true })).toEqual({
      sendConfirmationSms: false, sendConfirmation: false, sendCardOnFileLink: undefined,
    });
    // A group already recorded from a prior partial-failure retry also
    // disqualifies a "first" group on this attempt.
    expect(firstGroupSendFlags({ resultsCount: 0, createdCount: 1, sendSms: true, cardLinkAvailable: true, sendCardLink: true }).sendConfirmation).toBe(false);
  });

  it('omits the card link when it is unavailable or the operator did not opt in', () => {
    expect(firstGroupSendFlags({ resultsCount: 0, createdCount: 0, sendSms: true, cardLinkAvailable: false, sendCardLink: true }).sendCardOnFileLink).toBeUndefined();
    expect(firstGroupSendFlags({ resultsCount: 0, createdCount: 0, sendSms: true, cardLinkAvailable: true, sendCardLink: false }).sendCardOnFileLink).toBeUndefined();
  });
});

describe('recurringScheduleFields', () => {
  it('sends everything undefined for a one-time group', () => {
    expect(recurringScheduleFields({ isRecurring: false, group: { cadence: 'one_time' }, recurringCount: '4', skipWeekends: true, weekendShift: 'back' }))
      .toEqual({
        recurringPattern: undefined, recurringCount: undefined, recurringOngoing: undefined,
        recurringIntervalDays: undefined, recurringNth: undefined, recurringWeekday: undefined,
        skipWeekends: undefined, weekendShift: undefined,
      });
  });

  it('leaves recurringCount undefined (ongoing) when the operator typed nothing usable', () => {
    const fields = recurringScheduleFields({ isRecurring: true, group: { cadence: 'quarterly' }, recurringCount: '', skipWeekends: false, weekendShift: 'forward' });
    expect(fields).toMatchObject({ recurringPattern: 'quarterly', recurringCount: undefined, recurringOngoing: true });
  });

  it('sends a finite recurringCount only when the operator typed >= 2', () => {
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'quarterly' }, recurringCount: '6', skipWeekends: false, weekendShift: 'forward' }))
      .toMatchObject({ recurringCount: 6, recurringOngoing: false });
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'quarterly' }, recurringCount: '1', skipWeekends: false, weekendShift: 'forward' }))
      .toMatchObject({ recurringCount: undefined, recurringOngoing: true });
  });

  it('sends the custom interval / nth-weekday config only for the matching cadence', () => {
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'custom', intervalDays: 42 }, recurringCount: '', skipWeekends: false, weekendShift: 'forward' }))
      .toMatchObject({ recurringIntervalDays: 42, recurringNth: undefined, recurringWeekday: undefined });
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'monthly_nth_weekday', nth: 3, weekday: 2 }, recurringCount: '', skipWeekends: false, weekendShift: 'forward' }))
      .toMatchObject({ recurringNth: 3, recurringWeekday: 2, recurringIntervalDays: undefined });
  });

  it('sends weekendShift only when skipWeekends is on', () => {
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'weekly' }, recurringCount: '', skipWeekends: true, weekendShift: 'back' }))
      .toMatchObject({ skipWeekends: true, weekendShift: 'back' });
    expect(recurringScheduleFields({ isRecurring: true, group: { cadence: 'weekly' }, recurringCount: '', skipWeekends: false, weekendShift: 'back' }))
      .toMatchObject({ skipWeekends: false, weekendShift: undefined });
  });
});

describe('boosterMonthsForGroup', () => {
  it('is undefined for a one-time group even with booster months on a line', () => {
    expect(boosterMonthsForGroup({ lines: [{ boosterMonths: [3, 6] }] }, false)).toBeUndefined();
  });

  it('unions and sorts booster months across every line, dropping out-of-range picks', () => {
    expect(boosterMonthsForGroup({ lines: [{ boosterMonths: [6, 13] }, { boosterMonths: [3, 6, 0] }] }, true)).toEqual([3, 6]);
  });

  it('is undefined (not an empty array) when no line carries a booster month', () => {
    expect(boosterMonthsForGroup({ lines: [{}, { boosterMonths: [] }] }, true)).toBeUndefined();
  });
});

describe('prepaidFields', () => {
  it('is undefined unless both collectPrepay and isRecurring are true', () => {
    expect(prepaidFields({ collectPrepay: false, isRecurring: true, recurringCount: '4', groupSubtotal: 100, prepayMethod: 'cash', prepayNote: '' })).toEqual({ prepaid: undefined });
    expect(prepaidFields({ collectPrepay: true, isRecurring: false, recurringCount: '4', groupSubtotal: 100, prepayMethod: 'cash', prepayNote: '' })).toEqual({ prepaid: undefined });
  });

  it('projects the subtotal across the finite typed count when >= 2', () => {
    expect(prepaidFields({ collectPrepay: true, isRecurring: true, recurringCount: '6', groupSubtotal: 100, prepayMethod: 'check', prepayNote: 'ck #204' }))
      .toEqual({ prepaid: { totalAmount: 600, method: 'check', note: 'ck #204' } });
  });

  it('falls back to the 4-visit default when the count is not a usable finite number', () => {
    expect(prepaidFields({ collectPrepay: true, isRecurring: true, recurringCount: '', groupSubtotal: 100, prepayMethod: 'cash', prepayNote: '' }))
      .toEqual({ prepaid: { totalAmount: 400, method: 'cash', note: undefined } });
  });
});

describe('decideAnnualPrepayAttachment', () => {
  const baseInput = {
    billAsAnnualPrepay: true,
    isRecurring: true,
    prepayAttachedThisSubmit: false,
    noExtras: true,
    groupHasBoosters: false,
    group: { cadence: 'quarterly', intervalDays: null },
    linkedEstimate: { status: 'sent', prepay: { eligible: true } },
  };

  it('attaches and stamps billingTerm when every condition holds', () => {
    expect(decideAnnualPrepayAttachment(baseInput)).toEqual({ attach: true, billingTerm: 'prepay_annual' });
  });

  it('never attaches twice in one submit', () => {
    expect(decideAnnualPrepayAttachment({ ...baseInput, prepayAttachedThisSubmit: true })).toEqual({ attach: false, billingTerm: undefined });
  });

  it('refuses a one-time group, an already-accepted estimate, or an ineligible prepay', () => {
    expect(decideAnnualPrepayAttachment({ ...baseInput, isRecurring: false }).attach).toBe(false);
    expect(decideAnnualPrepayAttachment({ ...baseInput, linkedEstimate: { status: 'accepted', prepay: { eligible: true } } }).attach).toBe(false);
    expect(decideAnnualPrepayAttachment({ ...baseInput, linkedEstimate: { status: 'sent', prepay: { eligible: false } } }).attach).toBe(false);
    expect(decideAnnualPrepayAttachment({ ...baseInput, linkedEstimate: null }).attach).toBe(false);
  });

  it('refuses a group carrying add-on lines or booster months (stale-toggle belt-and-suspenders)', () => {
    expect(decideAnnualPrepayAttachment({ ...baseInput, noExtras: false }).attach).toBe(false);
    expect(decideAnnualPrepayAttachment({ ...baseInput, groupHasBoosters: true }).attach).toBe(false);
  });

  it('refuses a cadence with no defined annual coverage (e.g. an nth-weekday series)', () => {
    expect(decideAnnualPrepayAttachment({ ...baseInput, group: { cadence: 'monthly_nth_weekday' } }).attach).toBe(false);
  });
});

describe('matchesPrepayTarget', () => {
  it('matches by group identity, not by "the first result"', () => {
    expect(matchesPrepayTarget({ targetKey: 'quarterly', key: 'quarterly', result: { id: 'sched-1' } })).toBe(true);
    expect(matchesPrepayTarget({ targetKey: 'quarterly', key: 'monthly', result: { id: 'sched-1' } })).toBe(false);
  });

  it('is false with no target, or a result missing an id', () => {
    expect(matchesPrepayTarget({ targetKey: null, key: 'quarterly', result: { id: 'sched-1' } })).toBe(false);
    expect(matchesPrepayTarget({ targetKey: 'quarterly', key: 'quarterly', result: null })).toBe(false);
    expect(matchesPrepayTarget({ targetKey: 'quarterly', key: 'quarterly', result: {} })).toBe(false);
  });
});

describe('submitFailureNotice', () => {
  it('reads as a toast for a duplicate-program conflict, review-only wording with nothing yet created', () => {
    expect(submitFailureNotice({ firstError: { duplicate: true, label: 'Quarterly', message: 'x' }, created: 0, total: 2 }))
      .toEqual({ toastText: 'Review the existing recurring program below.', alertText: null });
  });

  it('reads as a toast naming what already saved for a duplicate conflict after a partial split', () => {
    expect(submitFailureNotice({ firstError: { duplicate: true, label: 'Quarterly', message: 'x' }, created: 1, total: 2 }))
      .toEqual({ toastText: '1 of 2 appointment series saved. Review the remaining program below.', alertText: null });
  });

  it('reads as a blocking alert for a genuine error, with a retry hint only once something landed', () => {
    expect(submitFailureNotice({ firstError: { duplicate: false, label: 'Quarterly', message: 'network down' }, created: 0, total: 1 }))
      .toEqual({ toastText: null, alertText: 'Failed: network down' });
    expect(submitFailureNotice({ firstError: { duplicate: false, label: 'Monthly', message: '500' }, created: 1, total: 2 }))
      .toEqual({ toastText: null, alertText: '1 of 2 appointment series created. Monthly failed: 500. Click Save to retry the rest.' });
  });
});

describe('shouldMintManualPrepay', () => {
  it('requires the toggle, an armed eligible preview, and a committed series id', () => {
    expect(shouldMintManualPrepay({ billAsManualPrepay: true, manualPrepayArmable: true, prepaySeriesId: 'sched-1' })).toBe(true);
    expect(shouldMintManualPrepay({ billAsManualPrepay: false, manualPrepayArmable: true, prepaySeriesId: 'sched-1' })).toBe(false);
    expect(shouldMintManualPrepay({ billAsManualPrepay: true, manualPrepayArmable: false, prepaySeriesId: 'sched-1' })).toBe(false);
    expect(shouldMintManualPrepay({ billAsManualPrepay: true, manualPrepayArmable: true, prepaySeriesId: null })).toBe(false);
  });
});

describe('assertManualPrepayMintEligible', () => {
  it('throws when the re-fetched preview is no longer eligible', () => {
    expect(() => assertManualPrepayMintEligible({ fresh: { eligible: false, blockReason: 'the series was edited' }, manualPrepay: { prepayTotal: 500 } }))
      .toThrow('annual prepay the series was edited');
  });

  it('throws with a generic reason when none is given', () => {
    expect(() => assertManualPrepayMintEligible({ fresh: { eligible: false }, manualPrepay: null }))
      .toThrow('annual prepay is no longer available for this booking');
  });

  it('throws when the re-priced total drifted from what the operator approved on screen', () => {
    expect(() => assertManualPrepayMintEligible({ fresh: { eligible: true, prepayTotal: 520 }, manualPrepay: { prepayTotal: 500 } }))
      .toThrow('the price changed while booking — you approved $500.00 but the committed visit prices at $520.00, so nothing was invoiced');
  });

  it('does not throw when eligible and the total is unchanged (cent-rounding tolerant)', () => {
    expect(() => assertManualPrepayMintEligible({ fresh: { eligible: true, prepayTotal: 500.001 }, manualPrepay: { prepayTotal: 500 } })).not.toThrow();
  });
});

describe('classifyManualPrepayMintOutcome', () => {
  it('reports account-credit settlement with no blocking alert', () => {
    const outcome = classifyManualPrepayMintOutcome({
      minted: { invoice: { invoice_number: 'INV-9' }, delivery: { covered_by_credit: true }, warnings: ['note'] },
      fresh: { prepayTotal: 500 },
    });
    expect(outcome).toEqual({
      notice: 'Annual prepay invoice INV-9 for $500.00 was settled by account credit — nothing was sent to the customer.',
      warnings: ['note'],
      blockingAlert: null,
    });
  });

  it('raises a blocking alert when the invoice was created but sending it failed', () => {
    const outcome = classifyManualPrepayMintOutcome({
      minted: { invoice: {}, delivery: { ok: false } },
      fresh: { prepayTotal: 500 },
    });
    expect(outcome.warnings).toEqual([]);
    expect(outcome.notice).toContain('sending it failed');
    expect(outcome.blockingAlert).toContain('SENDING IT FAILED');
  });

  it('reports a plain sent notice on the happy path', () => {
    expect(classifyManualPrepayMintOutcome({ minted: { invoice: { invoice_number: 'INV-1' }, delivery: { ok: true } }, fresh: { prepayTotal: 250 } }))
      .toEqual({ notice: 'Annual prepay invoice INV-1 sent for $250.00.', warnings: [], blockingAlert: null });
  });
});

describe('composeAppointmentSuccessToast', () => {
  it('names the estimate acceptance and a single appointment, invoice-with-report copy', () => {
    expect(composeAppointmentSuccessToast({ resultsCount: 1, createdCount: 0, estimateAccepted: true, prepayNotice: '' }))
      .toBe('Estimate marked accepted. Appointment created — invoice will send with service report');
  });

  it('pluralizes for a split save and falls back to createdCount when nothing posted this attempt', () => {
    expect(composeAppointmentSuccessToast({ resultsCount: 0, createdCount: 2, estimateAccepted: false, prepayNotice: '' }))
      .toBe('2 appointment series created — invoices will send with each service report');
  });

  it('drops the per-visit invoicing copy when a prepay notice is present', () => {
    expect(composeAppointmentSuccessToast({ resultsCount: 1, createdCount: 0, estimateAccepted: false, prepayNotice: 'Annual prepay invoice sent for $500.00.' }))
      .toBe('Appointment created Annual prepay invoice sent for $500.00.');
  });
});
