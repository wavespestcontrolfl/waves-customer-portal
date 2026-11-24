// The snapshot save draws the map into an image, at times after a fetch of the
// map, before its upload starts. So it runs through holdReloadWhileSending
// (lib/reloadHolds.js, tested there): an out-of-date tab keeps a snapshot that
// is still on its way. The modal renders a live map, so this is a source pin.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('every snapshot save goes through the zone-map hold', () => {
  const modal = readFileSync(new URL('./TechTreatmentZoneModal.jsx', import.meta.url), 'utf8');
  expect(modal).toContain("const save = useCallback(() => holdReloadWhileSending('zone-map', saveSnapshot), [saveSnapshot]);");
  expect(modal.match(/saveSnapshot/g)).toHaveLength(3);
});
