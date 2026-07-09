import { describe, expect, it } from 'vitest';
import { SERVICE_COPY, estimateCopyFor } from './estimate-copy';

describe('estimate-copy', () => {
  it('has a pre_slab_termiticide entry so a pre-slab quote never falls back to pest-control copy', () => {
    const copy = estimateCopyFor('pre_slab_termiticide');
    expect(copy).not.toBe(SERVICE_COPY.pest_control);
    expect(copy.aiTitle).toBe('Waves AI reviewed the slab area before pricing this estimate');
    expect(copy.askChips).toContain('What warranty is selected?');
  });

  it('falls back to pest-control copy only for unknown categories', () => {
    expect(estimateCopyFor('not_a_category')).toBe(SERVICE_COPY.pest_control);
    expect(estimateCopyFor('bora_care')).toBe(SERVICE_COPY.bora_care);
  });
});
