// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  glassCopyActive,
  glassEstimateCopyFor,
  glassPestInclusions,
  glassRewriteSlotSummary,
  glassSchedQualifier,
  glassSchedTitle,
  glassTierDisplay,
} from './estimate-glass-copy';

const setSearch = (search) => {
  window.history.replaceState(null, '', `/e/test${search}`);
};

afterEach(() => {
  setSearch('');
  vi.useRealTimers();
});

describe('glassCopyActive', () => {
  it('is active only when the URL carries ?glass=1', () => {
    expect(glassCopyActive()).toBe(false);
    setSearch('?glass=1');
    expect(glassCopyActive()).toBe(true);
    setSearch('?glass=0');
    expect(glassCopyActive()).toBe(false);
  });
});

describe('glassEstimateCopyFor', () => {
  it('returns the pest pack only for glass + pest_control', () => {
    setSearch('?glass=1');
    expect(glassEstimateCopyFor('pest_control')).not.toBeNull();
    // Other categories keep standard copy until their packs are approved.
    expect(glassEstimateCopyFor('lawn_care')).toBeNull();
    setSearch('');
    expect(glassEstimateCopyFor('pest_control')).toBeNull();
  });
});

describe('glassTierDisplay', () => {
  it('renames only Bronze — no ladder on a single-plan estimate', () => {
    expect(glassTierDisplay('Bronze')).toBe('Home Protection');
    expect(glassTierDisplay('WaveGuard Bronze')).toBe('Home Protection');
    expect(glassTierDisplay('Silver')).toBe('Silver');
    expect(glassTierDisplay('Gold')).toBe('Gold');
    expect(glassTierDisplay(null)).toBe(null);
  });
});

describe('glassPestInclusions', () => {
  it('states the real visit count in the perimeter bullet', () => {
    expect(glassPestInclusions(6)[1]).toMatch(/^Protected 6× a year/);
    expect(glassPestInclusions(0)[1]).toMatch(/^Protected 4× a year/);
  });

  it('advertises the $99 setup waiver only when the estimate carries a waivable fee', () => {
    expect(glassPestInclusions(4)).toHaveLength(6);
    const withSetup = glassPestInclusions(4, true);
    expect(withSetup).toHaveLength(7);
    expect(withSetup[6]).toMatch(/^\$99 setup disappears/);
  });
});

describe('glassSchedQualifier', () => {
  it('maps the first slot date to today / tomorrow / this week on the ET calendar', () => {
    vi.useFakeTimers();
    // 15:00Z = 11:00 ET → the ET date is 2026-07-05 whatever the machine TZ.
    vi.setSystemTime(new Date('2026-07-05T15:00:00Z'));
    expect(glassSchedQualifier('2026-07-05')).toBe('today');
    expect(glassSchedQualifier('2026-07-06')).toBe('tomorrow');
    expect(glassSchedQualifier('2026-07-10')).toBe('this week');
    // Beyond a week (or no slot) → no claim, caller falls back.
    expect(glassSchedQualifier('2026-07-20')).toBe(null);
    expect(glassSchedQualifier(null)).toBe(null);
    expect(glassSchedTitle(null)).toBe(null);
    expect(glassSchedTitle('today')).toBe('Lock in your spot — openings as soon as today');
  });
});

describe('glassRewriteSlotSummary', () => {
  it('leads with availability instead of the missing route', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here are 4 open times for Tuesday, July 8.',
      'sometime Tuesday',
    )).toBe('4 open times for Tuesday, July 8 — pick what works:');
  });

  it('rewrites the singular one-slot form too', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here is 1 open time for Monday, July 7.',
      'monday',
    )).toBe('1 open time for Monday, July 7 — pick what works:');
  });

  it('folds in the customer’s daypart qualifier when they used one', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here are 2 open times for Friday, July 11.',
      'Friday Morning if possible',
    )).toBe('2 open times for Friday morning (July 11) — pick what works:');
  });

  it('passes anything else through untouched', () => {
    expect(glassRewriteSlotSummary('Booked solid that day.', 'x')).toBe('Booked solid that day.');
    expect(glassRewriteSlotSummary(undefined, '')).toBe(undefined);
  });
});
