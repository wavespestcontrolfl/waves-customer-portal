// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechOutSection from './TechOutSection';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('renders nothing when the feature gate is off (404)', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ enabled: false }) });
  const { container } = render(<TechOutSection techId="tech-1" techName="Tech One" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(container).toBeEmptyDOMElement();
});

describe('not out today', () => {
  beforeEach(() => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
  });

  it('marks the tech out after an inline confirm, POSTing the selected reason', async () => {
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Availability');

    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    expect(await screen.findByText(/Reassign Tech One's stops to the rest of the crew/)).toBeInTheDocument();

    let releasePost;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('button', { name: 'Redistributing…' })).toBeDisabled();

    await act(async () => {
      releasePost({
        ok: true,
        status: 201,
        json: async () => ({
          absence: { id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null },
          summary: {
            total: 3,
            moved: [{ job_id: 'j1', to_technician_id: 'tech-2', to_technician_name: 'Tech Two', detour_minutes: 8 }],
            parked: [{ job_id: 'j2', alert_id: 'alert-1', bump_order: 1 }],
            failed: [],
          },
        }),
      });
    });

    expect(await screen.findByText('Out today · Sick')).toBeInTheDocument();
    const [, postCall] = fetch.mock.calls;
    expect(postCall[0]).toBe('/api/admin/tech-out/tech-1');
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({ reason: 'sick', note: undefined });
  });

  it('shows "Already marked out" inline on a 409 already_out response', async () => {
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Availability');
    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    await screen.findByRole('button', { name: 'Confirm' });

    fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'already_out' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Already marked out')).toBeInTheDocument();
  });
});

describe('out today', () => {
  const absence = {
    id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'emergency', note: 'Car trouble',
    created_at: new Date().toISOString(), cleared_at: null,
    redistribution: {
      total: 4,
      moved: [
        { job_id: 'j1', to_technician_id: 'tech-2', to_technician_name: 'Tech Two', detour_minutes: 5 },
        { job_id: 'j2', to_technician_id: 'tech-3', to_technician_name: 'Tech Three', detour_minutes: 12 },
      ],
      parked: [{ job_id: 'j3', alert_id: 'alert-1', bump_order: 1 }],
      failed: [],
    },
  };

  beforeEach(() => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence }) });
  });

  it('shows the redistribution summary counts and moved stops', async () => {
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    expect(await screen.findByText('Out today · Emergency')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // moved
    expect(screen.getByText('1')).toBeInTheDocument(); // parked
    expect(screen.getByText('→ Tech Two')).toBeInTheDocument();
    expect(screen.getByText('→ Tech Three')).toBeInTheDocument();
    expect(screen.getByText(/Parked stops are in the Action Queue/)).toBeInTheDocument();
  });

  it('clears the absence via DELETE on "Tech is back" and refetches', async () => {
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Emergency');

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ absence: { ...absence, cleared_at: new Date().toISOString() }, resolvedAlerts: ['alert-1'] }) });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });

    fireEvent.click(screen.getByRole('button', { name: 'Tech is back' }));
    await screen.findByText('Availability');

    const deleteCall = fetch.mock.calls[1];
    expect(deleteCall[0]).toContain('/api/admin/tech-out/tech-1?date=');
    expect(deleteCall[1].method).toBe('DELETE');
  });
});

// Codex P1 on PR #4678: the seq guard used to cover only the status GET —
// a mark-out POST or a "Tech is back" DELETE for tech A that resolved
// after the dispatcher had already selected tech B could still paint A's
// redistribution result into B's drawer.
describe('cross-tech mutation race (Codex P1)', () => {
  it('discards a stale POST response after switching to a different tech before it resolves', async () => {
    const onChanged = vi.fn();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });

    const { rerender } = render(
      <TechOutSection techId="tech-1" techName="Tech One" onChanged={onChanged} />
    );
    await screen.findByText('Availability');

    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    await screen.findByRole('button', { name: 'Confirm' });

    let releasePost;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('button', { name: 'Redistributing…' });

    // Dispatcher switches to tech-2 before A's POST resolves.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    rerender(<TechOutSection techId="tech-2" techName="Tech Two" onChanged={onChanged} />);
    await screen.findByText('Availability');
    expect(screen.getByRole('button', { name: 'Mark out today' })).toBeInTheDocument();

    // Now A's POST resolves with a redistribution summary.
    await act(async () => {
      releasePost({
        ok: true,
        status: 201,
        json: async () => ({
          absence: { id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null },
          summary: { total: 1, moved: [{ job_id: 'j1', to_technician_id: 'tech-9', to_technician_name: 'Tech Nine' }], parked: [], failed: [] },
        }),
      });
    });

    // B's view is unaffected: no "Out today" banner, still the plain
    // Availability form, and onChanged fired only for whatever B's own
    // lifecycle triggers (never for the discarded tech-1 POST).
    expect(screen.queryByText(/Out today/)).toBeNull();
    expect(screen.getByText('Availability')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark out today' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('discards a stale DELETE response after switching to a different tech before it resolves', async () => {
    const onChanged = vi.fn();
    const absence = {
      id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null,
      redistribution: { total: 1, moved: [], parked: [], failed: [] },
    };
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence }) });

    const { rerender } = render(
      <TechOutSection techId="tech-1" techName="Tech One" onChanged={onChanged} />
    );
    await screen.findByText('Out today · Sick');

    let releaseDelete;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releaseDelete = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Tech is back' }));
    await screen.findByRole('button', { name: 'Clearing…' });

    // Dispatcher switches to tech-2 (not out) before A's DELETE resolves.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    rerender(<TechOutSection techId="tech-2" techName="Tech Two" onChanged={onChanged} />);
    await screen.findByText('Availability');

    // Now A's DELETE resolves successfully.
    await act(async () => {
      releaseDelete({ ok: true, json: async () => ({ absence: { ...absence, cleared_at: new Date().toISOString() } }) });
    });

    // B's view is unaffected, and the stale DELETE must not have triggered
    // a fetchStatus(tech-1) call or onChanged() on B's behalf.
    expect(screen.getByText('Availability')).toBeInTheDocument();
    expect(screen.queryByText(/Out today/)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    // Only 3 fetches total: tech-1 GET, tech-2 GET, tech-1 DELETE. No
    // extra fetchStatus(tech-1) call snuck in after the discard.
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
