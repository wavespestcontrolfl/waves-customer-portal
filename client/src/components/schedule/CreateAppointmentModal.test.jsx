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
