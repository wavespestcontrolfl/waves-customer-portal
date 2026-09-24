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
      tech_name: 'Tech One', customer_first_name: 'Test', customer_last_name: 'Customer', scheduled_date: '2026-09-11',
      payload: { source: 'no_show_detector', stage: 2, promised_window: { start_at: '2026-09-11T14:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText('Tech One')).toBeTruthy();
    expect(screen.getByText('Test C.')).toBeTruthy();
    expect(screen.getByText('The promised window ended over 30 minutes ago; no arrival is recorded.')).toBeTruthy();
  });

  it('shows Unassigned when a tracking card has no technician', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'unassigned_overdue', severity: 'warn', created_at: new Date().toISOString(),
      customer_first_name: 'Sample', customer_last_name: 'Customer', scheduled_date: '2026-09-11',
      payload: { source: 'no_show_detector', stage: 1, message: 'No departure or arrival is recorded for this window yet.' } }} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Sample C.')).toBeTruthy();
  });

  // codex P1: the card's date/time must come from the PROMISED window, not
  // the visit's mutable scheduled_date/window_start/window_end — a service
  // block shorter than the arrival promise (or an uncommunicated internal
  // move) must not repaint the card with a different time than the one the
  // stage-2 message is judging.
  it('renders the promised window, not the mutable scheduled_date/window fields', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_name: 'Tech One', customer_first_name: 'Test', customer_last_name: 'Customer',
      // A shorter, moved service block — must not be what renders.
      scheduled_date: '2026-09-12', window_start: '14:00', window_end: '15:00',
      payload: { source: 'no_show_detector', stage: 2,
        promised_window: { start_at: '2026-09-11T13:00:00.000Z', end_at: '2026-09-11T15:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText(/9\/11\/2026/)).toBeTruthy();
    // Both ends of the promised arrival window render as a compressed
    // range, same style as the tech card (codex P2).
    expect(screen.getByText(/9:00–11:00 AM/)).toBeTruthy();
    expect(screen.queryByText(/9\/12\/2026/)).toBeNull();
    expect(screen.queryByText(/2:00 PM/)).toBeNull();
  });

  // codex P2: TrackingBody used to format only promised_window.start_at —
  // a dispatcher saw a single arrival time with no idea how long the
  // promised window actually runs. Cover both compression cases: a shared
  // meridiem drops the redundant AM/PM off the start time, a crossed one
  // keeps both.
  it('renders both ends of the promised window as a range', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_name: 'Tech One', customer_first_name: 'Test', customer_last_name: 'Customer',
      payload: { source: 'no_show_detector', stage: 2,
        promised_window: { start_at: '2026-09-11T13:00:00.000Z', end_at: '2026-09-11T15:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText(/9:00–11:00 AM/)).toBeTruthy();
  });

  it('keeps both meridiems when the window crosses noon', () => {
    render(<AlertCard alert={{ id: 'alert', type: 'tech_late', severity: 'critical', created_at: new Date().toISOString(),
      tech_name: 'Tech One', customer_first_name: 'Test', customer_last_name: 'Customer',
      payload: { source: 'no_show_detector', stage: 2,
        // 15:00Z-17:00Z = 11 AM-1 PM EDT.
        promised_window: { start_at: '2026-09-11T15:00:00.000Z', end_at: '2026-09-11T17:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText(/11:00 AM–1:00 PM/)).toBeTruthy();
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
        customer_first_name: 'Demo', customer_last_name: 'Customer',
        promised_window: { start_at: '2026-09-11T13:00:00.000Z', end_at: '2026-09-11T15:00:00.000Z' },
        message: 'The promised window ended over 30 minutes ago; no arrival is recorded.' } }} />);
    expect(screen.getByText('Jordan Reyes')).toBeTruthy();
    expect(screen.getByText('Demo C.')).toBeTruthy();
    expect(screen.queryByText('Unassigned')).toBeNull();
  });
});

describe('tech_out_overflow alert', () => {
  it('renders the "Needs a decision" header label, bump order, and bump reason', () => {
    render(<AlertCard alert={{
      id: 'alert', type: 'tech_out_overflow', severity: 'warn', created_at: new Date().toISOString(),
      tech_name: 'Tech One', customer_first_name: 'Test', customer_last_name: 'Customer',
      service_type: 'General pest', window_start: '09:00:00', window_end: '11:00:00',
      payload: {
        date: '2026-09-23', reason: 'sick', absent_tech_name: 'Tech One',
        customer_name: 'Test Customer', service_type: 'General pest',
        window_start: '09:00:00', window_end: '11:00:00',
        bump_order: 2, bump_total: 5, bump_reason: 'Recurring service, unconfirmed window',
        near_misses: [{ technician_id: 'tech-x', technician_name: 'Tech X', conflict_reason: 'already at capacity' }],
      },
    }} />);
    expect(screen.getByText('Needs a decision')).toBeTruthy();
    expect(screen.getByText('Tech One')).toBeTruthy();
    expect(screen.getByText(/bump #2 of 5/)).toBeTruthy();
    expect(screen.getByText('Recurring service, unconfirmed window')).toBeTruthy();
    expect(screen.getByText(/Test C\./)).toBeTruthy();
    expect(screen.getByText(/General pest/)).toBeTruthy();
    expect(screen.getByText(/9:00–11:00/)).toBeTruthy();
    expect(screen.getByText(/Closest fits: Tech X \(already at capacity\)/)).toBeTruthy();
  });

  it('falls back to payload identity fields on a bare live-socket row', () => {
    render(<AlertCard alert={{
      id: 'alert', type: 'tech_out_overflow', severity: 'warn', created_at: new Date().toISOString(),
      tech_id: 'tech-b', job_id: 'visit-1',
      payload: {
        date: '2026-09-23', reason: 'emergency', absent_tech_name: 'Jordan Reyes',
        customer_name: 'Demo Customer', service_type: 'Lawn', bump_order: 1, bump_total: 3,
      },
    }} />);
    expect(screen.getByText('Jordan Reyes')).toBeTruthy();
    expect(screen.getByText(/is out \(emergency\)/)).toBeTruthy();
    expect(screen.getByText(/Demo Customer/)).toBeTruthy();
  });
});

describe('unknown alert type', () => {
  it('falls back to GenericBody with the default uppercase label', () => {
    render(<AlertCard alert={{
      id: 'alert', type: 'some_future_type', severity: 'info', created_at: new Date().toISOString(),
      tech_name: 'Tech One', payload: { foo: 'bar' },
    }} />);
    expect(screen.getByText('some_future_type')).toBeTruthy();
    expect(screen.getByText('Tech One')).toBeTruthy();
    expect(screen.getByText('bar')).toBeTruthy();
  });
});
