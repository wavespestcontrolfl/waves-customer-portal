// @vitest-environment jsdom
// A failed reassignment must not close the picker as if it had worked
// (UI audit 2026-09-07, STATES-02).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InlineTechPicker from './InlineTechPicker';

const TECHS = [{ id: 't1', name: 'Tech One' }];

describe('InlineTechPicker assignment outcome', () => {
  beforeEach(() => { localStorage.setItem('waves_admin_token', 'test-token'); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('keeps the picker open and names the failure when the PUT fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
    const onAssigned = vi.fn();
    const onClose = vi.fn();
    render(<InlineTechPicker serviceId="svc-1" currentTechId={null} technicians={TECHS} onAssigned={onAssigned} onClose={onClose} anchorRect={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tech One' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onAssigned).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Tech One' })).toBeEnabled();
  });

  it('reports the assignment and closes when the PUT succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const onAssigned = vi.fn();
    const onClose = vi.fn();
    render(<InlineTechPicker serviceId="svc-1" currentTechId={null} technicians={TECHS} onAssigned={onAssigned} onClose={onClose} anchorRect={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tech One' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onAssigned).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
