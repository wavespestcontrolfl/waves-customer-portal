// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechOutSection from './TechOutSection';
import { TECH_ABSENCE_EVENT } from '../../hooks/useDispatchBoard';

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
    expect(await screen.findByText(/Mark Tech One out and park today's stops for a decision/)).toBeInTheDocument();

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
      moved: [],
      parked: [{ job_id: 'j3', alert_id: 'alert-1', bump_order: 1 }],
      failed: [],
    },
  };

  beforeEach(() => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence }) });
  });

  it('shows the parked-count primary line and the Action Queue hint', async () => {
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    expect(await screen.findByText('Out today · Emergency')).toBeInTheDocument();
    expect(screen.getByText('1 stop parked in the Action Queue — decide who to move')).toBeInTheDocument();
    expect(screen.getByText(/Parked stops are in the Action Queue as/)).toBeInTheDocument();
  });

  it('park-only foundation: never renders moved / failed stat cells or a moved list (the server does not emit them in this version)', async () => {
    fetch.mockReset();
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enabled: true,
        absence: {
          id: 'abs-2', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null,
          // Even a stray non-empty moved/failed (an older client contract) renders nothing.
          redistribution: { total: 2, moved: [{ job_id: 'j9', to_technician_name: 'Tech Nine' }], parked: [{ job_id: 'j1', alert_id: 'alert-1', bump_order: 1 }, { job_id: 'j2', alert_id: 'alert-2', bump_order: 2 }], failed: [{ job_id: 'j8' }] },
        },
      }),
    });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    expect(await screen.findByText('Out today · Sick')).toBeInTheDocument();
    expect(screen.getByText('2 stops parked in the Action Queue — decide who to move')).toBeInTheDocument();
    expect(screen.queryByText('moved')).toBeNull();
    expect(screen.queryByText('failed')).toBeNull();
    expect(screen.queryByText(/→ /)).toBeNull();
    expect(screen.getByText(/Parked stops are in the Action Queue as/)).toBeInTheDocument();
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
describe('unmount mid-mutation (auditor P1)', () => {
  it('a POST that resolves after the section unmounted still refreshes the board (onChanged) but renders nothing', async () => {
    const onChanged = vi.fn();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    const { unmount } = render(
      <TechOutSection techId="tech-1" techName="Tech One" onChanged={onChanged} />
    );
    await screen.findByText('Availability');
    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    await screen.findByRole('button', { name: 'Confirm' });

    let releasePost;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('button', { name: 'Redistributing…' });

    // Drawer closed (section unmounted) before A's POST resolves.
    unmount();
    await act(async () => {
      releasePost({
        ok: true,
        status: 201,
        json: async () => ({
          absence: { id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null },
          summary: { total: 1, moved: [], parked: [{ job_id: 'j1', alert_id: 'a1', bump_order: 1 }], failed: [] },
        }),
      });
    });

    // The server committed the mark-out: the roster must refresh even though
    // this drawer is gone. Nothing rendered, no error thrown.
    expect(onChanged).toHaveBeenCalledWith('tech-1');
  });
});

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
    // The committed mutation still refreshes the board (reported for tech-1);
    // only B's drawer state is protected from it.
    expect(onChanged).toHaveBeenCalledWith('tech-1');
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
    // The committed mutation still refreshes the board (reported for tech-1);
    // only B's drawer state is protected from it.
    expect(onChanged).toHaveBeenCalledWith('tech-1');
    // Only 3 fetches total: tech-1 GET, tech-2 GET, tech-1 DELETE. No
    // extra fetchStatus(tech-1) call snuck in after the discard.
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('gate closed mid-drawer (Codex r7 P2 on PR #4678)', () => {
  it('a 404 on confirm hides the section instead of showing an error', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Availability');
    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    await screen.findByRole('button', { name: 'Confirm' });

    fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ enabled: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByText('Availability')).toBeNull());
    expect(screen.queryByText(/Failed to mark out|HTTP 404/)).toBeNull();
  });

  it('a 404 on "Tech is back" hides the section', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enabled: true,
        absence: { id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null, redistribution: { total: 0, parked: [] } },
      }),
    });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Sick');

    fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ enabled: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'Tech is back' }));

    await waitFor(() => expect(screen.queryByText('Out today · Sick')).toBeNull());
    expect(screen.queryByText('Availability')).toBeNull();
    expect(screen.queryByText(/Failed to clear|HTTP 404/)).toBeNull();
  });
});

describe('remote changes and a second clear (Codex r8 P2s on PR #4678)', () => {
  it('"Tech is back" answered 404 not_out (someone else cleared it) returns to the Availability form, not off', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, absence: { id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null, redistribution: { total: 0, parked: [] } } }),
    });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Sick');

    fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'not_out' }) });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    fireEvent.click(screen.getByRole('button', { name: 'Tech is back' }));

    expect(await screen.findByText('Availability')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark out today' })).toBeInTheDocument();
  });

  it('a remote mark-out for the shown tech refetches status; one for another tech is ignored', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Availability');
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(TECH_ABSENCE_EVENT, { detail: { tech_id: 'tech-9', date: '2026-09-23', out: true } }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, absence: { id: 'abs-2', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'emergency', note: null, redistribution: { total: 0, parked: [] } } }),
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TECH_ABSENCE_EVENT, { detail: { tech_id: 'tech-1', date: '2026-09-23', out: true } }));
    });
    expect(await screen.findByText('Out today · Emergency')).toBeInTheDocument();
  });
});

describe('a remote refetch that supersedes an in-flight mutation (pre-push auditor P1 on PR #4678)', () => {
  it('Confirm is not left stuck on "Redistributing…" and the refetched status wins', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Availability');
    fireEvent.click(screen.getByRole('button', { name: 'Mark out today' }));
    await screen.findByRole('button', { name: 'Confirm' });

    let releasePost;
    fetch.mockReturnValueOnce(new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('button', { name: 'Redistributing…' })).toBeDisabled();

    // Another tab's mark-out for this same tech lands while our POST is
    // pending: the drawer refetches (status now shows the absence).
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, absence: { id: 'abs-r', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'sick', note: null, redistribution: { total: 0, parked: [] } } }),
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TECH_ABSENCE_EVENT, { detail: { tech_id: 'tech-1', date: '2026-09-23', out: true } }));
    });
    expect(await screen.findByText('Out today · Sick')).toBeInTheDocument();

    // Our own POST now resolves (409 already_out): superseded, discarded,
    // and nothing is stuck.
    await act(async () => {
      releasePost({ ok: false, status: 409, json: async () => ({ error: 'already_out' }) });
    });
    expect(screen.getByText('Out today · Sick')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redistributing…' })).toBeNull();
    expect(screen.queryByText('Already marked out')).toBeNull();
    // The form is usable again after a remote clear (status → no absence):
    // still in its confirm step, but Confirm is enabled, not stuck.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TECH_ABSENCE_EVENT, { detail: { tech_id: 'tech-1', date: '2026-09-23', out: false } }));
    });
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeEnabled();
  });
});

// PR B — GATE_TECH_OUT_AUTO_MOVE.
describe('auto-assign parked stops (GATE_TECH_OUT_AUTO_MOVE)', () => {
  const outAbsence = (overrides = {}) => ({
    id: 'abs-1', technician_id: 'tech-1', absence_date: '2026-09-23', reason: 'emergency', note: null,
    redistribution: { total: 2, moved: [], parked: [{ job_id: 'j1' }, { job_id: 'j2' }], failed: [] },
    parked_open_count: 2,
    ...overrides,
  });

  it('hides the button when the auto-move gate is off, even while out with parked stops', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: outAbsence(), auto_move_enabled: false }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Emergency');
    expect(screen.queryByRole('button', { name: 'Auto-assign parked stops' })).toBeNull();
  });

  it('hides the button when nothing is parked, even with the gate on', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, absence: outAbsence({ parked_open_count: 0, redistribution: { total: 0, parked: [] } }), auto_move_enabled: true }),
    });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Emergency');
    expect(screen.queryByRole('button', { name: 'Auto-assign parked stops' })).toBeNull();
  });

  it('shows the button when the gate is on and stops are parked; POSTs and shows moved/left-parked counts', async () => {
    const onChanged = vi.fn();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: outAbsence(), auto_move_enabled: true }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" onChanged={onChanged} />);
    await screen.findByText('Out today · Emergency');

    const btn = screen.getByRole('button', { name: 'Auto-assign parked stops' });
    let releasePost;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(btn);
    expect(await screen.findByRole('button', { name: 'Assigning…' })).toBeDisabled();

    // Refetch after the POST resolves picks up the new live count.
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, absence: outAbsence({ parked_open_count: 1 }), auto_move_enabled: true }),
    });
    await act(async () => {
      releasePost({ ok: true, json: async () => ({ enabled: true, auto_move_enabled: true, moved: [{ alert_id: 'a1', job_id: 'j1', to_technician_id: 'tech-2' }], left_parked: [{ alert_id: 'a2', reason: 'no_eligible_candidate' }] }) });
    });

    expect(await screen.findByText('Moved 1, left 1 parked for a decision.')).toBeInTheDocument();
    expect(screen.getByText('1 stop parked in the Action Queue — decide who to move')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith('tech-1');

    const postCall = fetch.mock.calls[1];
    expect(postCall[0]).toBe('/api/admin/tech-out/tech-1/auto-assign');
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({ date: expect.any(String) });
  });

  it('shows an inline error on failure and re-enables the button', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: outAbsence(), auto_move_enabled: true }) });
    render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Emergency');

    fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Auto-assign parked stops' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-assign parked stops' })).toBeEnabled();
  });

  it('a response landing after the tech selection changed is discarded', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: outAbsence(), auto_move_enabled: true }) });
    const { rerender } = render(<TechOutSection techId="tech-1" techName="Tech One" />);
    await screen.findByText('Out today · Emergency');

    let releasePost;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto-assign parked stops' }));
    await screen.findByRole('button', { name: 'Assigning…' });

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null, auto_move_enabled: false }) });
    rerender(<TechOutSection techId="tech-2" techName="Tech Two" />);
    await screen.findByText('Availability');

    await act(async () => {
      releasePost({ ok: true, json: async () => ({ enabled: true, moved: [{ alert_id: 'a1' }], left_parked: [] }) });
    });
    // Nothing from the stale response leaked into tech-2's view.
    expect(screen.queryByText(/Moved 1/)).toBeNull();
    expect(screen.getByText('Availability')).toBeInTheDocument();
  });
});
