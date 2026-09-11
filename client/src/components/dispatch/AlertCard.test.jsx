// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AlertCard from './AlertCard';
afterEach(cleanup);
describe('communication-based dispatch warnings', () => {
  it.each(['tech_late', 'unassigned_overdue'])('shows missing evidence for %s without claiming a verified late arrival', (type) => {
    render(<AlertCard alert={{ id: 'alert', type, severity: 'warn', created_at: new Date().toISOString(),
      payload: { source: 'no_show_detector', stage: 1, message: 'No departure or arrival is recorded for this window yet.' } }} />);
    expect(screen.getByText('Missing tracking')).toBeTruthy();
    expect(screen.getByText('No departure or arrival is recorded for this window yet.')).toBeTruthy();
    expect(screen.queryByText(/behind schedule|past its window/)).toBeNull();
  });

  // codex P1 (af4925f71): the tracking body must identify the affected
  // visit — customer/technician/window — not just the generic sentence,
  // using the same hydrated fields /admin/dispatch/alerts already returns.
  it('identifies the affected visit on a tracking card', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_name: 'Adam Benetti', customer_first_name: 'Maya', customer_last_name: 'Magno', scheduled_date: '2026-09-11',
      payload: { source: 'no_show_detector', stage: 2, promised_window: { start_at: '2026-09-11T14:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText('Adam Benetti')).toBeTruthy();
    expect(screen.getByText('Maya M.')).toBeTruthy();
    expect(screen.getByText('The promised window ended over 30 minutes ago; no arrival is recorded.')).toBeTruthy();
  });

  it('shows Unassigned when a tracking card has no technician', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'unassigned_overdue', severity: 'warn', created_at: new Date().toISOString(),
      customer_first_name: 'Ken', customer_last_name: 'Ichi', scheduled_date: '2026-09-11',
      payload: { source: 'no_show_detector', stage: 1, message: 'No departure or arrival is recorded for this window yet.' } }} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Ken I.')).toBeTruthy();
  });

  // codex P1: the card's date/time must come from the PROMISED window, not
  // the visit's mutable scheduled_date/window_start/window_end — a service
  // block shorter than the arrival promise (or an uncommunicated internal
  // move) must not repaint the card with a different time than the one the
  // stage-2 message is judging.
  it('renders the promised window, not the mutable scheduled_date/window fields', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_name: 'Adam Benetti', customer_first_name: 'Maya', customer_last_name: 'Magno',
      // A shorter, moved service block — must not be what renders.
      scheduled_date: '2026-09-12', window_start: '14:00', window_end: '15:00',
      payload: { source: 'no_show_detector', stage: 2,
        promised_window: { start_at: '2026-09-11T13:00:00.000Z', end_at: '2026-09-11T15:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText(/9\/11\/2026/)).toBeTruthy();
    expect(screen.getByText(/9:00 AM/)).toBeTruthy();
    expect(screen.queryByText(/9\/12\/2026/)).toBeNull();
    expect(screen.queryByText(/2:00 PM/)).toBeNull();
  });

  // codex P1: createAlertOnce's dispatch:alert broadcast carries the bare
  // inserted row — no joined tech_name/customer — until the next /alerts
  // hydration. An admin with the board already open must still see who and
  // when on an assigned stage-2 card from the identity fields the detector
  // now writes into the payload itself.
  it('falls back to payload identity fields on a bare live-socket row', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_id: 'tech-b', job_id: 'visit-1',
      // No row-level tech_name / customer_first_name / customer_last_name —
      // exactly what the bare dispatch:alert broadcast looks like.
      payload: { source: 'no_show_detector', stage: 2, tech_name: 'Jordan Reyes',
        customer_first_name: 'Bart', customer_last_name: 'Davis',
        promised_window: { start_at: '2026-09-11T13:00:00.000Z', end_at: '2026-09-11T15:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText('Jordan Reyes')).toBeTruthy();
    expect(screen.getByText('Bart D.')).toBeTruthy();
    expect(screen.queryByText('Unassigned')).toBeNull();
  });
});
