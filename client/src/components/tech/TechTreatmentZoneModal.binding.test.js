// Every trace opener binds its save to the property it loaded the visit at,
// so a save that waited on the visit lock behind an office move never lands
// a map of the old home on the new one (Codex #5538). Only the report flow
// also asks for an open visit; the Zone action may still trace a completed
// visit. The modal itself renders a live map, so these are source pins.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('trace saves bound to the loaded property', () => {
  test('the modal sends the loaded property and, for the report flow only, the open-visit ask', () => {
    const modal = read('./TechTreatmentZoneModal.jsx');
    expect(modal).toContain('...(expectedPropertyId !== undefined ? { expectedPropertyId } : {}),');
    expect(modal).toContain('...(openVisitOnly ? { openVisitOnly: true } : {}),');
    expect(read('./FastCompleteSheet.jsx')).toMatch(/expectedPropertyId=\{loadedPropertyId\}\s+openVisitOnly\b/);
  });

  test('the schedule forms and the Zone action pass the property their visit row was loaded at', () => {
    const binding = (row) => `expectedPropertyId={'propertyId' in ${row} ? (${row}.propertyId ?? null) : undefined}`;
    expect(read('../../pages/admin/SchedulePage.jsx').split(binding('service')).length - 1).toBe(2);
    expect(read('../../pages/tech/TechHomePage.jsx')).toContain(binding('zoneTarget'));
  });
});
