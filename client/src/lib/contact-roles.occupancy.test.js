import { describe, expect, it } from 'vitest';
import { OCCUPANCY_OPTIONS, propertyRelationshipChip } from './contact-roles';

describe('occupancy vocabulary', () => {
  it('offers Family-occupied between owner-occupied and rental (owner ruling 2026-09-08)', () => {
    const values = OCCUPANCY_OPTIONS.map((o) => o.value);
    expect(values).toEqual(['unknown', 'owner_occupied', 'family_occupied', 'rental_investment', 'seasonal', 'vacant', 'commercial']);
    expect(OCCUPANCY_OPTIONS.find((o) => o.value === 'family_occupied').label).toBe('Family-occupied');
  });

  it('property chip falls back to the occupancy label when no relationship is recorded', () => {
    expect(propertyRelationshipChip({ occupancy_type: 'family_occupied', relationship: null })).toBe('Family-occupied');
    expect(propertyRelationshipChip({ occupancy_type: 'family_occupied', relationship: 'family_home' })).not.toBe('Family-occupied');
    expect(propertyRelationshipChip({ occupancy_type: 'unknown', relationship: null })).toBe('');
  });
});
