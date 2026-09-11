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
});
