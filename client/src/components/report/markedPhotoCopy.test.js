import { describe, expect, it } from 'vitest';
import { MARKED_PHOTO_INTRO, markedPhotoCaption } from './markedPhotoCopy';

// These are customer-facing CLAIM rules, not styling preferences — see
// docs/design/treatment-animation-scope.md.
describe('marked-photo copy', () => {
  it('uses the foam wording only when every mark is a foam injection', () => {
    expect(markedPhotoCaption([{ kind: 'foam_injection' }], 'foamPoints'))
      .toMatch(/^Foam was injected at the points your technician marked/);
  });

  it('never claims a foam injection over a wood-treated point', () => {
    const mixed = markedPhotoCaption(
      [{ kind: 'foam_injection' }, { kind: 'wood_treatment' }],
      'foamPoints',
    );
    expect(mixed).not.toMatch(/Foam was injected/);
    expect(mixed).toMatch(/marked the points treated/);
    expect(markedPhotoCaption([{ kind: 'wood_treatment' }], 'foamPoints'))
      .not.toMatch(/Foam was injected/);
  });

  it('states no total and claims no exhaustive set', () => {
    const texts = [
      MARKED_PHOTO_INTRO,
      markedPhotoCaption([{ kind: 'foam_injection' }], 'foamPoints'),
      markedPhotoCaption([{ kind: 'wood_treatment' }], 'foamPoints'),
      markedPhotoCaption([], null),
    ];
    for (const text of texts) {
      // Foam is priced by drill-point count and marks are optional, so any
      // total invites a customer to tally pins against billed points.
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/\ball\b|\beach\b|\bevery\b/i);
    }
  });

  it('falls back to neutral wording for an unknown caption key', () => {
    expect(markedPhotoCaption([{ kind: 'foam_injection' }], 'somethingElse'))
      .toMatch(/marked the points treated/);
  });
});
