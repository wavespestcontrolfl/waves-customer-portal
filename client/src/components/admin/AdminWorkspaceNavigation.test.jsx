// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminWorkspaceNavigation from './AdminWorkspaceNavigation';
import { AdminNavigationProvider } from '../../hooks/useAdminNavigation';
import useRenderedTabBeacon from '../../hooks/useRenderedTabBeacon';
import { markUsageSource } from '../../lib/adminUsage';

vi.mock('../NotificationBell', () => ({ default: () => null }));
vi.mock('../../lib/adminUsage', () => ({ markUsageSource: vi.fn(), trackAdminPageView: vi.fn() }));

function RenderedPage() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') || 'leads');
  useEffect(() => {
    if (location.pathname !== '/admin/pipeline' || !params.has('tab')) return;
    setTab(params.get('tab'));
    setParams({}, { replace: true });
  }, [location.pathname, params, setParams]);
  useRenderedTabBeacon('/admin/pipeline', location.pathname === '/admin/pipeline' ? tab : null, [params]);
  return <output data-testid="route">{location.pathname}{location.search}</output>;
}

const account = { id: 'fixture-admin', name: 'Fixture admin', role: 'admin' };
function Fixture({ user = account, enabled = true, route = '/admin/dashboard', onClose = vi.fn() }) {
  return <MemoryRouter initialEntries={[route]}>
    <AdminNavigationProvider key={user.id} user={user} enabled={enabled}>
      <AdminWorkspaceNavigation user={user} onClose={onClose} onAsk={vi.fn()} onLogout={vi.fn()} unreadCount={5} />
      <RenderedPage />
    </AdminNavigationProvider>
  </MemoryRouter>;
}

beforeEach(() => {
  const values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('workspace navigation', () => {
  it('separates navigation from expansion and closes a same-page mobile tap', () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Sales' }));
    expect(screen.getByTestId('route')).toHaveTextContent('/admin/dashboard');
    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(markUsageSource).not.toHaveBeenCalled();
  });

  it('keeps Estimates current after the page consumes its query, and can return to Pipeline', async () => {
    render(<Fixture route="/admin/pipeline?tab=estimates" />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent(/^\/admin\/pipeline$/));
    expect(screen.getByRole('link', { name: 'Estimates' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('link', { name: 'Pipeline' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('link', { name: 'Estimates' })).not.toHaveAttribute('aria-current');
    expect(markUsageSource).toHaveBeenCalledWith('sidebar');
  });

  it('preserves modified links without closing this drawer or attributing a new page here', () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    const sales = screen.getByRole('link', { name: 'Sales' });
    expect(sales).toHaveAttribute('href', '/admin/pipeline?tab=leads');
    document.addEventListener('click', (event) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault(); // jsdom cannot perform the browser's new-tab navigation
    }, { once: true });
    fireEvent.click(sales, { ctrlKey: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(markUsageSource).not.toHaveBeenCalled();
  });

  it('persists expansion per account and recovers from corrupt preferences', () => {
    localStorage.setItem('waves_admin_navigation:fixture-admin', '{broken');
    const view = render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Operations' }));
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeVisible();
    view.unmount();
    const reload = render(<Fixture />);
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeVisible();
    reload.rerender(<Fixture user={{ id: 'fixture-tech', name: 'Fixture tech', role: 'technician' }} />);
    expect(screen.queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand Customers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sales' })).not.toBeInTheDocument();
  });

  it('allows collapsing the active group until navigation changes', async () => {
    render(<Fixture route="/admin/pipeline?tab=estimates" />);
    await screen.findByRole('link', { name: 'Estimates' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Sales' }));
    expect(screen.queryByRole('link', { name: 'Estimates' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Sales' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('announces unread conversations and renders no workspace menu when disabled', () => {
    const view = render(<Fixture />);
    const communications = screen.getByRole('link', { name: 'Communications , 5 unread conversations' });
    expect(within(communications).getByText('5')).toHaveAttribute('aria-hidden');
    view.rerender(<Fixture enabled={false} />);
    expect(screen.queryByRole('navigation', { name: 'Admin workspaces' })).not.toBeInTheDocument();
  });
});
