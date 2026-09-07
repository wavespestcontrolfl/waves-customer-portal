import { describe, it, expect } from 'vitest';
import { bestTimeLabel, bestDateLabel, pickedLabel } from './BestTimeHint';

describe('bestTimeLabel', () => {
  it('names the drive into the stop and what the insertion adds to the route', () => {
    expect(bestTimeLabel({ start: '09:00', driveInMinutes: 37, fromHomeBase: true, detourMinutes: 57 }))
      .toBe('9:00 AM · 37 min drive from home base · +57 min added to route');
  });

  it('names the previous stop when the van comes from a customer', () => {
    expect(bestTimeLabel({ start: '13:00', driveInMinutes: 12.4, fromHomeBase: false, fromName: 'Stop B', detourMinutes: 4.4 }))
      .toBe('1:00 PM · 12 min drive from Stop B · +4 min added to route');
  });

  it('says no added drive when the stop is on the way', () => {
    expect(bestTimeLabel({ start: '13:00', driveInMinutes: 6, fromHomeBase: false, fromName: 'Stop D', detourMinutes: 0 }))
      .toBe('1:00 PM · 6 min drive from Stop D · no added drive');
  });

  it('omits the drive-in leg when the slot has none (arrival-window mode) and treats a missing detour as none', () => {
    expect(bestTimeLabel({ start: '12:00', driveInMinutes: null, detourMinutes: null }))
      .toBe('12:00 PM · no added drive');
  });

  it('appends the technician on an unscoped search', () => {
    expect(bestTimeLabel({ start: '10:00', driveInMinutes: 5, fromHomeBase: true, detourMinutes: 3, technicianName: 'Adam' }))
      .toBe('10:00 AM · 5 min drive from home base · +3 min added to route · Adam');
  });
});

describe('bestDateLabel', () => {
  it('prefixes the weekday and date', () => {
    // Far-future fixture: fmtDate says "Today" for the ET date, so a near date would rot.
    expect(bestDateLabel({ date: '2035-01-10', start: '13:00', driveInMinutes: 8, fromHomeBase: false, fromName: 'Stop C', detourMinutes: 12 }))
      .toBe('Wed, Jan 10 · 1:00 PM · 8 min drive from Stop C · +12 min added to route');
  });
});

describe('pickedLabel', () => {
  it('states the cost of the hour already picked', () => {
    expect(pickedLabel({ start: '09:00', fits: true, driveInMinutes: 37, fromHomeBase: true, detourMinutes: 57 }))
      .toBe('9:00 AM: 37 min drive from home base · +57 min added to route');
  });

  it('says so when the picked hour does not fit the route', () => {
    expect(pickedLabel({ start: '16:00', fits: false }))
      .toBe("4:00 PM: doesn't fit that day's route");
  });

  it('shows only the route cost for an arrival-window answer', () => {
    expect(pickedLabel({ start: '11:00', fits: true, driveInMinutes: null, fromHomeBase: null, detourMinutes: 9 }))
      .toBe('11:00 AM: +9 min added to route');
  });
});
