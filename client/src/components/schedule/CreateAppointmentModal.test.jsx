import { describe, expect, it } from 'vitest';
import {
  bookableProperties,
  bookingPropertyTarget,
  buildFindTimeRequestBody,
  defaultBookingPropertyId,
  ESTIMATE_SOURCE_LABEL,
  filterScheduleEstimatesForProperty,
  findScheduleEstimateById,
  isBookableProperty,
  formatScheduleEstimateAmount,
  MANUAL_SERVICE_ENTRY_LABEL,
  pickAutoScheduleEstimate,
  quickAddConfirmFlags,
  quickAddConflictFromError,
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
