// Rodent trapping's count noun follows the visit the tech just declared.
// Owner 2026-08-02: "it could be just the first time trapping, but it also
// could be the second time trapping. So the traps checked thing in there
// could be traps set or traps checked." The closeout label has to agree with
// the report's label for the same number, or the form contradicts the PDF.
import { describe, expect, it } from 'vitest';
import { typedFieldLabel } from './SchedulePage';

const trapsChecked = { key: 'traps_checked', label: 'Traps checked', type: 'count' };

describe('typedFieldLabel', () => {
  it('reads "Traps set" once the tech declares an initial setup', () => {
    expect(typedFieldLabel('rodent_trapping', trapsChecked, { trap_visit_type: 'Initial setup' }))
      .toBe('Traps set');
  });

  it('keeps the registry label on a follow-up check', () => {
    expect(typedFieldLabel('rodent_trapping', trapsChecked, { trap_visit_type: 'Follow-up check' }))
      .toBe('Traps checked');
  });

  it('keeps the registry label when nothing is declared yet', () => {
    expect(typedFieldLabel('rodent_trapping', trapsChecked, {})).toBe('Traps checked');
    expect(typedFieldLabel('rodent_trapping', trapsChecked)).toBe('Traps checked');
  });

  it('never touches another schema that happens to carry the same key', () => {
    // wildlife_trapping shares traps_checked but has its own vocabulary.
    expect(typedFieldLabel('wildlife_trapping', trapsChecked, { trap_visit_type: 'Initial setup' }))
      .toBe('Traps checked');
  });

  it('leaves every other field alone', () => {
    const captures = { key: 'captures', label: 'Captures', type: 'count' };
    expect(typedFieldLabel('rodent_trapping', captures, { trap_visit_type: 'Initial setup' }))
      .toBe('Captures');
  });
});
