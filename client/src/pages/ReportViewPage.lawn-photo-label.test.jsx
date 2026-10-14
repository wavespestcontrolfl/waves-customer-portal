// @vitest-environment jsdom
// GATE_LAWN_PHOTO_LABEL_PICK on the web report photo strip: the alt text names the technician's chosen
// customer label, and is the legacy type wording whenever no label was picked (gate off sends no labelPicked).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lawnPhotoAlt } from './ReportViewPage';

describe('lawnPhotoAlt', () => {
  it('uses the picked label, lower-cased', () => {
    expect(lawnPhotoAlt({ type: 'shade_area', zone: 'shade', zoneLabel: 'Shaded area', labelPicked: 'Close-up' })).toBe('Lawn close-up');
  });

  it('keeps the legacy wording without a pick, and the generic text with no type', () => {
    expect(lawnPhotoAlt({ type: 'shade_area', zone: 'shade', zoneLabel: 'Shaded area' })).toBe('Lawn shade area');
    expect(lawnPhotoAlt({})).toBe('Lawn assessment photo');
  });

  it('the strip image and caption both read the pick', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/ReportViewPage.jsx'), 'utf8');
    expect(source).toContain('alt={lawnPhotoAlt(photo)}');
    expect(source).toContain('photo.labelPicked || photo.zoneLabel');
  });
});
