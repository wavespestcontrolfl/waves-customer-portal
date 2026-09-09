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
});
