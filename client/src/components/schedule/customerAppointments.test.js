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

  it('appointmentHistory is newest first and capped', () => {
    expect(appointmentHistory({ scheduled: history }, 2).map((s) => s.id)).toEqual(['x1', 'u1']);
    expect(appointmentHistory({}, 3)).toEqual([]);
  });
});
