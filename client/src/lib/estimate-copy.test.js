import { describe, expect, it } from 'vitest';
import { SERVICE_COPY, estimateCopyFor, estimateHeadlineFor } from './estimate-copy';

describe('estimate-copy', () => {
  it('has a pre_slab_termiticide entry so a pre-slab quote never says "choose your pest control option"', () => {
    const copy = estimateCopyFor('pre_slab_termiticide');
    expect(copy).not.toBe(SERVICE_COPY.pest_control);
    expect(copy.headline).toBe("Hey {first}, here's your pre-slab termite treatment quote.");
  });

  it('uses the quote-phrased headline for one-time-only estimates of "choose your option" categories', () => {
    const pest = estimateCopyFor('pest_control');
    expect(estimateHeadlineFor(pest, { isOneTimeOnly: true }))
      .toBe("Hey {first}, here's your one-time pest treatment quote.");
    expect(estimateHeadlineFor(pest, { isOneTimeOnly: false }))
      .toBe('Hey {first}, choose your pest control option.');
  });

  it('never invites an option choice on a one-time-only estimate, for any category', () => {
    Object.keys(SERVICE_COPY).forEach((category) => {
      const headline = estimateHeadlineFor(estimateCopyFor(category), { isOneTimeOnly: true });
      expect(headline).not.toMatch(/choose your/i);
    });
  });

  it('falls back to the base headline when a category has no one-time variant', () => {
    const trenching = estimateCopyFor('termite_trenching');
    expect(estimateHeadlineFor(trenching, { isOneTimeOnly: true })).toBe(trenching.headline);
  });
});
