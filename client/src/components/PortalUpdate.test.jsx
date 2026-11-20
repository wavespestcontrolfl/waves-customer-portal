// @vitest-environment jsdom
// The 11-19 failure: an open staff tab kept old estimate code for two hours
// after the fix went live. With option A (owner 2026-11-19) the next page move
// in an out-of-date tab loads the live code, the first page never reloads, a
// tab inside a page is not a move, held work stops it, and the Reload bar
// shows on staff pages only.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

vi.mock('../native/platform', () => ({ isWavesAdminApp: () => false }));

import { noteServerAnswer, resetPortalVersionForTests } from '../lib/portalVersion';
import { registerReloadHold } from '../lib/reloadHolds';
import { PortalUpdateBar, PortalUpdateGate } from './PortalUpdate';

let holding = false;
registerReloadHold('test-hold', () => holding);
let noticeOpen = false;
registerReloadHold('schedule-notice', () => noticeOpen);
let paying = false;
registerReloadHold('tap-to-pay', () => paying);
let reload;

const goLive = (build) => act(() => {
  noteServerAnswer(new Headers({ 'X-Portal-Build': build, 'X-Portal-Boot': '2000' }));
});

function Page({ name }) {
  const navigate = useNavigate();
  return (
    <div>
      <h1>{name}</h1>
      <button type="button" onClick={() => navigate('/admin/pipeline')}>Open Pipeline</button>
      <button type="button" onClick={() => navigate('?tab=leads')}>Leads tab</button>
    </div>
  );
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PortalUpdateBar />
      <PortalUpdateGate fallback={<p>Loading the new version...</p>}>
        <Routes>
          <Route path="/admin/dashboard" element={<Page name="Dashboard" />} />
          <Route path="/admin/pipeline" element={<Page name="Pipeline" />} />
          <Route path="/billing" element={<Page name="Billing" />} />
        </Routes>
      </PortalUpdateGate>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetPortalVersionForTests();
  document.head.insertAdjacentHTML('beforeend', '<meta name="portal-build" content="aaa111aaa111">');
  sessionStorage.clear();
  holding = false;
  noticeOpen = false;
  paying = false;
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
});

describe('PortalUpdateGate', () => {
  test('a page move in an out-of-date tab loads the live code once', async () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByText('Open Pipeline'));
    expect(screen.getByText('Loading the new version...')).toBeTruthy();
    expect(screen.queryByText('Pipeline')).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test('the page the tab loaded never reloads, and a tab inside a page is not a move', async () => {
    goLive('bbb222bbb222');
    renderAt('/admin/dashboard');
    fireEvent.click(screen.getByText('Leads tab'));
    expect(screen.getByText('Dashboard')).toBeTruthy();
    await act(async () => {});
    expect(reload).not.toHaveBeenCalled();
  });

  test('held work keeps the tab: the move opens the page and the bar stays', async () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    holding = true;
    fireEvent.click(screen.getByText('Open Pipeline'));
    expect(screen.getByText('Pipeline')).toBeTruthy();
    expect(screen.getByText('A new version of the portal is ready.')).toBeTruthy();
    await act(async () => {});
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('PortalUpdateBar', () => {
  test('shows on staff pages only, once a newer build is live', () => {
    renderAt('/admin/dashboard');
    expect(screen.queryByText('A new version of the portal is ready.')).toBeNull();
    goLive('aaa111aaa111');
    expect(screen.queryByText('A new version of the portal is ready.')).toBeNull();
    goLive('bbb222bbb222');
    expect(screen.getByText('A new version of the portal is ready.')).toBeTruthy();
  });

  test('stays off customer pages', () => {
    renderAt('/billing');
    goLive('bbb222bbb222');
    expect(screen.queryByText('A new version of the portal is ready.')).toBeNull();
  });

  test('Reload reloads; held work is named first, then Reload anyway', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    holding = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Something in this tab is still open.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('Reload anyway names new held work instead of reloading past it', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    noticeOpen = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('A schedule notice is still open.')).toBeTruthy();
    noticeOpen = false;
    paying = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('A Tap to Pay payment is still open.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('names every held work at once; Reload anyway then reloads', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    noticeOpen = true;
    paying = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('A schedule notice is still open. A Tap to Pay payment is still open.')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a page move clears the named work', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    holding = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('Something in this tab is still open.')).toBeTruthy();
    fireEvent.click(screen.getByText('Open Pipeline'));
    expect(screen.getByText('Pipeline')).toBeTruthy();
    expect(screen.getByText('A new version of the portal is ready.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  test('with nothing held, Reload reloads at once', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
