import { describe, it, expect } from 'vitest';
import { conflictLabel } from './SlotConflictNotice';

describe('conflictLabel', () => {
  it('names the customer with the service type when the server shared them', () => {
    expect(conflictLabel({
      customerName: 'Pat Smith', serviceType: 'Mosquito Treatment', isHold: false,
    })).toBe('Pat Smith (mosquito treatment)');
  });

  it('labels an estimate-slot hold when there is no customer', () => {
    expect(conflictLabel({ customerName: null, serviceType: null, isHold: true }))
      .toBe('An estimate-slot hold');
  });

  it('falls back to another appointment on name-scoped rows', () => {
    expect(conflictLabel({ customerName: null, serviceType: null, isHold: false }))
      .toBe('Another appointment');
  });
});
