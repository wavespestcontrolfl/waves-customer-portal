// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechCard from './TechCard';

afterEach(cleanup);

const job = {
  id: 'job-1',
  address: '123 Main St, Bradenton, FL 34203',
};

describe('out_today (Codex P2 on PR #4678)', () => {
  it('shows "Out" status text, hides ETA, and shows "—" for the address even with a live en_route status/current job/ETA', () => {
    const jobs = new Map([[job.id, job]]);
    const tech = {
      id: 'tech-1',
      name: 'Tech One',
      status: 'en_route',
      current_job_id: job.id,
      eta_minutes: 12,
      out_today: true,
      today_completed: 1,
      today_total: 3,
      location_updated_at: new Date().toISOString(),
    };
    render(<TechCard tech={tech} jobs={jobs} selected={false} onSelect={vi.fn()} isDropTarget={false} />);

    // "Out" appears twice — the Badge and the status line both render the
    // literal text "Out" — so assert the count instead of a single match,
    // and confirm neither the live status word nor the ETA leaked through.
    expect(screen.getAllByText('Out')).toHaveLength(2);
    expect(screen.queryByText('en_route')).toBeNull();
    expect(screen.queryByText(/MIN/)).toBeNull();
    expect(screen.queryByText(/123 Main St/)).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders normal status, ETA, and address when not out today', () => {
    const jobs = new Map([[job.id, job]]);
    const tech = {
      id: 'tech-1',
      name: 'Tech One',
      status: 'en_route',
      current_job_id: job.id,
      eta_minutes: 12,
      out_today: false,
      today_completed: 1,
      today_total: 3,
      location_updated_at: new Date().toISOString(),
    };
    render(<TechCard tech={tech} jobs={jobs} selected={false} onSelect={vi.fn()} isDropTarget={false} />);

    expect(screen.getByText('en_route')).toBeInTheDocument();
    expect(screen.getByText(/12 MIN/)).toBeInTheDocument();
    expect(screen.getByText(/123 Main St/)).toBeInTheDocument();
    expect(screen.queryByText('Out')).toBeNull();
  });
});
