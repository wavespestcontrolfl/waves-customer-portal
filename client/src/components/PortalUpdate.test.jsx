// @vitest-environment jsdom
// The 11-19 failure: an open staff tab kept old estimate code for two hours
// after the fix went live. With option A (owner 2026-11-19) the next page move
// in an out-of-date tab loads the live code, the first page never reloads, a
// tab inside a page is not a move, held work stops it, and the Reload bar
// shows on staff pages only.
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

vi.mock('../native/platform', () => ({ isWavesAdminApp: () => false }));

import { installPortalVersionWatch, noteServerAnswer, resetPortalVersionForTests } from '../lib/portalVersion';
import { registerReloadHold } from '../lib/reloadHolds';
import { countDeviceWrite } from '../lib/deviceWrites';
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
      <button type="button" onClick={() => navigate('/admin/dashboard')}>Open Dashboard</button>
      <button type="button" onClick={() => navigate('?tab=leads')}>Leads tab</button>
    </div>
  );
}

// Like the completion panel: saves its draft to the device's own storage as
// it closes.
let finishDraftSave = null;
function DraftPanel() {
  useEffect(() => () => {
    countDeviceWrite(new Promise((resolve) => { finishDraftSave = resolve; }));
  }, []);
  return <Page name="Dispatch" />;
}

// A field page whose changes live only in the page until Save, like the
// truck check: toggles, a typed note and a signature pad.
function TruckCheck() {
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  const [damaged, setDamaged] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div>
      <h1>Truck check</h1>
      <button type="button" aria-pressed={missing} onClick={() => setMissing(true)}>Missing</button>
      <button type="button" role="switch" aria-checked={damaged} onClick={() => setDamaged(true)}>Damaged</button>
      <input aria-label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
      <canvas aria-label="Signature" />
      <button type="button" onClick={() => navigate('/admin/today')}>Back</button>
    </div>
  );
}

// Like AdminIndexRedirect: the /admin index only redirects, to Today for a
// technician or with Field view on, else to the dashboard. Where shows the
// tab's path when it reloads.
function Home() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/admin')}>Home</button>;
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderWithIndex(landing) {
  return render(
    <MemoryRouter initialEntries={['/admin/pipeline']}>
      <Where />
      <PortalUpdateGate fallback={<p>Loading the new version...</p>}>
        <Routes>
          <Route path="/admin" element={<Navigate to={landing} replace />} />
          <Route path="/admin/pipeline" element={<Home />} />
          <Route path="/admin/dashboard" element={<Page name="Dashboard" />} />
          <Route path="/admin/today" element={<Page name="Today" />} />
        </Routes>
      </PortalUpdateGate>
    </MemoryRouter>,
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
          <Route path="/admin/today" element={<Page name="Today" />} />
          <Route path="/admin/dispatch" element={<DraftPanel />} />
          <Route path="/admin/today/truck-check" element={<TruckCheck />} />
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
  test('a page move waits for the draft that the closing page saves on the device, then reloads', async () => {
    renderAt('/admin/dispatch');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByText('Open Pipeline'));
    expect(screen.getByText('Loading the new version...')).toBeTruthy();
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(reload).not.toHaveBeenCalled();
    finishDraftSave();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

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

  test('a move away from a field page keeps the tab, as a time-clock punch there can still wait for the location; the next move reloads', async () => {
    renderAt('/admin/today');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByText('Open Pipeline'));
    expect(screen.getByText('Pipeline')).toBeTruthy();
    await act(async () => {});
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Open Dashboard'));
    expect(screen.getByText('Loading the new version...')).toBeTruthy();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test('a move to the /admin index only redirects: the tab reloads at the page it lands on', async () => {
    renderWithIndex('/admin/dashboard');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByText('Home'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('where').textContent).toBe('/admin/dashboard');
  });

  test('a move to the /admin index that lands on Today, for a technician or with Field view on, keeps the tab', async () => {
    renderWithIndex('/admin/today');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByText('Home'));
    expect(await screen.findByText('Today')).toBeTruthy();
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

  test('a request still open, as when a checkout reads the discount setting before it posts, is named first; Reload anyway then reloads', async () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    let finishRead;
    const target = { fetch: () => new Promise((resolve) => { finishRead = resolve; }) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/discounts/stacking');
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('A request is still on its way.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
      expect(reload).toHaveBeenCalledTimes(1);
      finishRead({ headers: new Headers() });
      await read;
    } finally {
      uninstall();
    }
  });

  test('Reload anyway past a named save names a read that started since, as the read can lead to a send', async () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => { pending.push(resolve); }) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const save = target.fetch('/api/admin/schedule/1/invoice', { method: 'POST' });
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(screen.getByText('A save is still on its way.')).toBeTruthy();
      const read = target.fetch('/api/admin/discounts/stacking');
      fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('A save is still on its way. A request is still on its way.')).toBeTruthy();
      pending.forEach((resolve) => resolve({ headers: new Headers() }));
      await Promise.all([save, read]);
    } finally {
      uninstall();
    }
  });

  test('an offline tab: Reload names it first, then Reload anyway reloads', () => {
    renderAt('/admin/dashboard');
    goLive('bbb222bbb222');
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('This device is offline. A reload may show an error page.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      offline.mockRestore();
    }
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

  test.each([
    ['a toggle button', () => fireEvent.click(screen.getByRole('button', { name: 'Missing' }))],
    ['a switch', () => fireEvent.click(screen.getByRole('switch', { name: 'Damaged' }))],
    ['a typed note', () => fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'Cracked hose' } })],
    ['a signature drawn on a canvas', () => fireEvent.pointerDown(screen.getByLabelText('Signature'))],
  ])('a use of the page in view (%s) is named before Reload drops its work', (_kind, change) => {
    renderAt('/admin/today/truck-check');
    goLive('bbb222bbb222');
    change();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Anything not saved on this page will be lost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a use of the page after the bar named its work clears the names, so the next Reload asks again', () => {
    renderAt('/admin/today/truck-check');
    goLive('bbb222bbb222');
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'Cracked hose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('Anything not saved on this page will be lost.')).toBeTruthy();
    // Back to the page: more typing is new work under a name already shown.
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'Cracked hose, left side' } });
    expect(screen.getByText('A new version of the portal is ready.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Anything not saved on this page will be lost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a page not used since it opened reloads at once, and a page move ends a use', () => {
    renderAt('/admin/today/truck-check');
    goLive('bbb222bbb222');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Missing' }));
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Today')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(2);
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
