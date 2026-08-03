import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_SOURCE_LABEL,
  findScheduleEstimateById,
  formatScheduleEstimateAmount,
  MANUAL_SERVICE_ENTRY_LABEL,
  pickAutoScheduleEstimate,
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
