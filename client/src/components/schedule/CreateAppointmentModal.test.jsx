import { describe, expect, it } from 'vitest';
import {
  findScheduleEstimateById,
  formatScheduleEstimateAmount,
  pickAutoScheduleEstimate,
} from './CreateAppointmentModal.jsx';

describe('CreateAppointmentModal won estimate helpers', () => {
  it('finds numeric estimate ids from select string values', () => {
    const estimates = [{ id: 42 }, { id: 108 }];

    expect(findScheduleEstimateById(estimates, '108')).toEqual({ id: 108 });
  });

  it('keeps cents in won estimate amounts', () => {
    expect(formatScheduleEstimateAmount({ onetimeTotal: 94.08 })).toBe('$94.08 one-time');
    expect(formatScheduleEstimateAmount({ monthlyTotal: '94.08' })).toBe('$94.08/mo');
  });

  it('auto-selects exactly one unlinked won estimate for an empty schedule form', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [{ id: 108, linkedAppointment: false }],
    })).toEqual({
      estimate: { id: 108, linkedAppointment: false },
      key: '7:108',
    });
  });

  it('does not auto-select when there are multiple unlinked won estimates', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [
        { id: 108, linkedAppointment: false },
        { id: 109, linkedAppointment: false },
      ],
    })).toBeNull();
  });

  it('does not auto-select the same won estimate twice', () => {
    expect(pickAutoScheduleEstimate({
      customerId: 7,
      estimates: [{ id: 108, linkedAppointment: false }],
      appliedKey: '7:108',
    })).toBeNull();
  });
});
