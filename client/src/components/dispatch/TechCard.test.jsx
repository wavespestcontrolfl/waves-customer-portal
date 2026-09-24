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

describe('out_today disables the drop target (Codex r4 P2 on PR #4678)', () => {
  it('renders no [data-tech-card-id] and no drop-target highlight for an out tech, even while isDropTarget is true', () => {
    const tech = {
      id: 'tech-1',
      name: 'Tech One',
      status: 'idle',
      current_job_id: null,
      out_today: true,
      today_completed: 0,
      today_total: 0,
      location_updated_at: null,
    };
    const { container } = render(
      <TechCard tech={tech} jobs={new Map()} selected={false} onSelect={vi.fn()} isDropTarget={true} />
    );

    // DispatchMap's onJobDragEnd hit-test only matches this attribute
    // (document.elementFromPoint(...).closest('[data-tech-card-id]')) — an
    // out card must not be findable as a drop target at all.
    expect(container.querySelector('[data-tech-card-id]')).toBeNull();
    // The dashed drop-zone ring and its Card highlight must not render
    // either, even though isDropTarget is true.
    expect(container.querySelector('.ring-dashed')).toBeNull();
  });

  it('stays selectable (onClick still fires) for an out tech with no drop-target attribute', () => {
    const onSelect = vi.fn();
    const tech = {
      id: 'tech-1',
      name: 'Tech One',
      status: 'idle',
      current_job_id: null,
      out_today: true,
      today_completed: 0,
      today_total: 0,
      location_updated_at: null,
    };
    render(<TechCard tech={tech} jobs={new Map()} selected={false} onSelect={onSelect} isDropTarget={false} />);

    screen.getByRole('button').click();
    expect(onSelect).toHaveBeenCalledWith('tech-1');
  });

  it('renders [data-tech-card-id] and the drop-target highlight for a normal tech when isDropTarget is true', () => {
    const tech = {
      id: 'tech-2',
      name: 'Tech Two',
      status: 'idle',
      current_job_id: null,
      out_today: false,
      today_completed: 0,
      today_total: 0,
      location_updated_at: null,
    };
    const { container } = render(
      <TechCard tech={tech} jobs={new Map()} selected={false} onSelect={vi.fn()} isDropTarget={true} />
    );

    expect(container.querySelector('[data-tech-card-id="tech-2"]')).not.toBeNull();
    expect(container.querySelector('.ring-dashed')).not.toBeNull();
  });
});
