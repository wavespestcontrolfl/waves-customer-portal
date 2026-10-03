import { describe, expect, it } from 'vitest';
import { photoVisitChanged } from './service-photo-recovery';

const captured = {
  customerId: 'customer-a', propertyId: 'property-a', technicianId: 'tech-a',
  scheduledDate: '2026-10-02', status: 'pending', revision: 'revision-a',
};

describe('recovered photo visit identity', () => {
  it.each(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed'])(
    'keeps the same photo when its visit advances to %s', (status) => {
      expect(photoVisitChanged(captured, { ...captured, status })).toBe(false);
    },
  );
  it.each(['cancelled', 'skipped', 'no_show', 'unknown', null])(
    'refuses recovery for an unavailable visit state %s', (status) => {
      expect(photoVisitChanged(captured, { ...captured, status })).toBe(true);
    },
  );
  it.each(['customerId', 'propertyId', 'technicianId', 'scheduledDate', 'revision'])(
    'still refuses a changed %s after check-in', (field) => {
      expect(photoVisitChanged(captured, { ...captured, [field]: 'changed', status: 'on_site' })).toBe(true);
    },
  );
  it('blocks one-sided snapshot absence while preserving the deployed legacy response', () => {
    expect(photoVisitChanged(captured, null)).toBe(true);
    expect(photoVisitChanged(null, captured)).toBe(true);
    expect(photoVisitChanged(null, null)).toBe(false);
  });
});
