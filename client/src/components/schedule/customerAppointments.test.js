import { describe, it, expect } from 'vitest';
import { upcomingAppointments, previousAppointments, appointmentHistory } from './customerAppointments';

const TODAY = '2026-08-23';
const history = [
  { id: 'h1', scheduled_date: '2026-08-20', status: 'completed' },
  { id: 'h2', scheduled_date: '2026-07-20', status: 'completed' },
  { id: 'u1', scheduled_date: '2026-09-20', status: 'pending' },
  { id: 'x1', scheduled_date: '2026-09-25', status: 'cancelled' },
  { id: 't1', scheduled_date: '2026-08-23', status: 'confirmed' },
];

describe('customerAppointments', () => {
  it('prefers the server upcomingScheduled list, sorted soonest first', () => {
    const data = { scheduled: history, upcomingScheduled: [{ id: 'u1', scheduled_date: '2026-09-20' }, { id: 't1', scheduled_date: '2026-08-23' }] };
    expect(upcomingAppointments(data, TODAY).map((s) => s.id)).toEqual(['t1', 'u1']);
  });

  it('falls back to filtering scheduled by ET-today and active status when upcomingScheduled is absent', () => {
    expect(upcomingAppointments({ scheduled: history }, TODAY).map((s) => s.id)).toEqual(['t1', 'u1']);
    // ISO stamps on the day compare by their date prefix, not local parsing.
    expect(upcomingAppointments({ scheduled: [{ id: 'z', scheduled_date: '2026-08-23T04:00:00.000Z', status: 'pending' }] }, TODAY)).toHaveLength(1);
  });

  it('previous = history minus upcoming, newest first (cancelled future rows land here)', () => {
    const data = { scheduled: history, upcomingScheduled: [{ id: 'u1' }, { id: 't1' }] };
    expect(previousAppointments(data, TODAY).map((s) => s.id)).toEqual(['x1', 'h1', 'h2']);
  });

  it('an active future row omitted from the capped server upcoming list never lands in previous', () => {
    const data = {
      scheduled: [...history, { id: 'u2', scheduled_date: '2026-12-01', status: 'pending' }],
      upcomingScheduled: [{ id: 'u1' }, { id: 't1' }], // u2 beyond the server cap
    };
    expect(previousAppointments(data, TODAY).map((s) => s.id)).toEqual(['x1', 'h1', 'h2']);
  });

  it('appointmentHistory = current + nearest upcoming, then most recent past, capped', () => {
    expect(appointmentHistory({ scheduled: history }, 3, { today: TODAY }).map((s) => s.id)).toEqual(['t1', 'x1', 'h1']);
    expect(appointmentHistory({}, 3)).toEqual([]);
  });

  it('a 24-visit future series never crowds out the current visit and recent past', () => {
    const future = Array.from({ length: 24 }, (_, i) => ({
      id: `f${i}`, scheduled_date: `2027-${String(1 + (i % 12)).padStart(2, '0')}-${i < 12 ? '05' : '20'}`, status: 'pending',
    }));
    const past = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, scheduled_date: `2026-0${8 - i}-10`, status: 'completed' }));
    const current = { id: 'cur', scheduled_date: '2026-09-01', status: 'confirmed' };
    const data = { scheduled: [...future, ...past, current] };
    const ids = appointmentHistory(data, 8, { today: TODAY, currentId: 'cur' }).map((s) => s.id);
    expect(ids).toEqual(['cur', 'p0', 'p1', 'p2', 'p3', 'p4']);
    // With no current id the nearest upcoming leads, and still no far-future rows.
    const noCur = appointmentHistory(data, 8, { today: TODAY }).map((s) => s.id);
    expect(noCur[0]).toBe('cur');
    expect(noCur.some((id) => id.startsWith('f'))).toBe(false);
  });
});
