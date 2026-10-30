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

  it('keeps Estimates current after the page consumes its query, and can return to Pipeline through Sales', async () => {
    render(<Fixture route="/admin/pipeline?tab=estimates" />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent(/^\/admin\/pipeline$/));
    expect(screen.getByRole('link', { name: 'Estimates' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Pipeline' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Sales' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sales' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('link', { name: 'Estimates' })).not.toHaveAttribute('aria-current');
    expect(markUsageSource).toHaveBeenCalledWith('sidebar');
  });

  it('lists every page once: a group row opens its main page and lists only the other pages', () => {
    render(<Fixture route="/admin/customers" />);
    const customers = screen.getAllByRole('link', { name: 'Customers' });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toHaveAttribute('href', '/admin/customers');
    expect(customers[0]).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Contracts' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Gate codes' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Schedule' }));
    expect(screen.getAllByRole('link', { name: 'Schedule' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Today' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Settings' }));
    expect(screen.getAllByRole('link', { name: 'Settings' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Health' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Billing' }));
    expect(screen.queryByRole('link', { name: 'Invoices' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/admin/invoices');
    expect(screen.getByRole('link', { name: 'Recovery' })).toBeVisible();
  });

  it('closes a group it opened for the page on screen when navigation leaves it, and keeps groups opened by hand', async () => {
    render(<Fixture route="/admin/customers" />);
    expect(screen.getByRole('link', { name: 'Contracts' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Operations' }));
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Billing' }));
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/admin/invoices'));
    expect(screen.getByRole('link', { name: 'Recovery' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Contracts' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeVisible();
    const saved = JSON.parse(localStorage.getItem('waves_admin_navigation:fixture-admin'));
    expect(saved).toMatchObject({ version: 2, groups: { operations: true } });
    expect(saved.groups).not.toHaveProperty('customers');
    expect(saved.groups).not.toHaveProperty('billing');
  });

  it('drops groups saved before version 2 once and keeps the pins', () => {
    localStorage.setItem('waves_admin_navigation:fixture-admin', JSON.stringify({ groups: { operations: true, marketing: true }, pins: ['customers'] }));
    render(<Fixture />);
    expect(screen.queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Newsletter' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Pinned pages' })).getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/admin/customers');
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

  it('announces conversations needing a reply and renders no workspace menu when disabled', () => {
    const view = render(<Fixture />);
    const communications = screen.getByRole('link', { name: 'Communications , 5 conversations needing a reply' });
    expect(communications).toHaveAttribute('href', '/admin/communications');
    expect(within(communications).getByText('5')).toHaveAttribute('aria-hidden');
    view.rerender(<Fixture enabled={false} />);
    expect(screen.queryByRole('navigation', { name: 'Admin workspaces' })).not.toBeInTheDocument();
  });
});
