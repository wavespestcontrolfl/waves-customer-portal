// @vitest-environment jsdom
// A plain price/notes edit must not rewrite the visit's stored service type
// (UI audit 2026-09-07, SMS-01): only a tier the tech changed does.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileServiceEditModal from './MobileServiceEditModal';

const saveNotice = vi.hoisted(() => ({ shown: [] }));
vi.mock('./ScheduleSaveNotice', async (importOriginal) => ({
  ...(await importOriginal()),
  showScheduleSaveNotice: (message) => { saveNotice.shown.push(message); },
}));

const SERVICE = {
  id: 'svc-1',
  serviceType: 'Lawn Care - Track B',
  estimatedPrice: 99,
  technicianId: '',
  estimatedDuration: 30,
  notes: '',
};

function lastPutBody() {
  const call = fetch.mock.calls.find(([url, opts]) => String(url).endsWith('/admin/schedule/svc-1/update-details') && opts?.method === 'PUT');
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

describe('MobileServiceEditModal save payload', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); saveNotice.shown.length = 0; });

  it('omits serviceType when the tech did not pick a different tier', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = lastPutBody();
    expect(body).not.toHaveProperty('serviceType');
    expect(body.estimatedPrice).toBe(99);
  });

  it('rewrites serviceType only from a tier the tech chose', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Quarterly/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastPutBody().serviceType).toBe('Lawn Care - Track B — Quarterly');
  });

  it('a refused change on a shared stop asks whole stop or separate, and the answer rides the next save', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 'This service is grouped with another at the same stop.', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }), { status: 409 }),
      new Response(JSON.stringify({ success: true, comboMove: { moved: true, warnings: ['Fixture overlap warning.'] } }), { status: 200 }),
    ];
    fetch.mockImplementation(async () => answers.shift());
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const ask = await screen.findByRole('group', { name: 'This stop has more than one service' });
    expect(ask).toHaveTextContent('Nothing was changed.');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change the whole stop' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const puts = fetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT').map(([, opts]) => JSON.parse(opts.body));
    expect(puts[0]).not.toHaveProperty('comboMove');
    expect(puts[1].comboMove).toBe('together');
    // A warning the whole-stop change returned (a double booking) is shown.
    expect(saveNotice.shown).toEqual(['Saved.\n\nFixture overlap warning.']);
  });

  it('a whole-stop change that was partly done, did not confirm, or was refused is reported as that', async () => {
    const outcomes = [
      { moved: false, needsAttention: { message: 'Only part of this stop was reassigned: fixture repair text.' } },
      { moved: null, error: 'connection reset' },
      { moved: false, error: 'Technician is inactive.' },
    ];
    for (const comboMove of outcomes) {
      fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, comboMove }), { status: 200 }));
      const onSaved = vi.fn();
      const view = render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      view.unmount();
    }
    expect(saveNotice.shown).toEqual([
      'The other changes were saved. Only part of this stop was reassigned: fixture repair text.',
      'The other changes were saved. The technician change did not confirm, so the stop may or may not have changed: check the schedule. (connection reset)',
      "The other changes were saved, but the stop's technician was not changed: Technician is inactive.",
    ]);
  });

  it('a whole-stop save that gets no answer is reported as unconfirmed, not as failed', async () => {
    const answers = [
      async () => new Response(JSON.stringify({ error: 'grouped', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }), { status: 409 }),
      async () => { throw new TypeError('Failed to fetch'); },
    ];
    fetch.mockImplementation(() => answers.shift()());
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change the whole stop' }));
    expect(await screen.findByText('The save did not confirm, so it may or may not have gone through. Close this and check the schedule before you save again.')).toBeInTheDocument();
  });

  describe('auto-dispatch lock box', () => {
    const OCCURRENCE = { ...SERVICE, isRecurring: true, recurringParentId: 'parent-1', autoDispatchLocked: true };
    const LABEL = 'Keep auto-dispatch off this visit';
    const lockCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/admin/auto-dispatch/services/svc-1/lock'));
    const asRole = (role) => localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
    beforeEach(() => asRole('admin'));

    it('hides the box from a technician: the lock endpoint is admin-only', () => {
      asRole('technician');
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });


    it('shows the box checked for a locked recurring occurrence and hides it otherwise', () => {
      const view = render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.getByLabelText(new RegExp(LABEL))).toBeChecked();
      view.unmount();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, isRecurring: false, recurringParentId: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it('clearing the box calls the lock endpoint with locked false after update-details', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByLabelText(new RegExp(LABEL)));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const urls = fetch.mock.calls.map(([url]) => String(url));
      expect(urls.findIndex((u) => u.endsWith('/update-details'))).toBeLessThan(urls.findIndex((u) => u.endsWith('/lock')));
      expect(lockCalls()).toHaveLength(1);
      expect(lockCalls()[0][1].method).toBe('PATCH');
      expect(JSON.parse(lockCalls()[0][1].body)).toEqual({ locked: false });
    });

    it('saving without touching the box makes no lock call', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lockCalls()).toHaveLength(0);
    });

    it('a failed lock call still counts as saved and shows a notice', async () => {
      fetch.mockImplementation(async (url) => (String(url).endsWith('/lock')
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })));
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByLabelText(new RegExp(LABEL)));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(saveNotice.shown[0]).toMatch(/^Saved, but the auto-dispatch setting was not changed/);
    });
  });
});
