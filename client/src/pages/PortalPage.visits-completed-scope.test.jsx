// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { ServicesTab, VisitsTab } from './PortalPage';
import { PortalReadProvider, usePortalRefresh } from '../hooks/usePortalRead';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', tier: 'Silver', property: {} };
const savedOnly = [{ id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } }];
const profileShaped = [{ id: 'cust-1' }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  api.getServices.mockResolvedValue({ services: [] });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
});
afterEach(() => cleanup());

const openCompleted = (props = {}) => render(
  <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} {...props} />
);

function PortalRefreshButton() {
  const portal = usePortalRefresh();
  return <button type="button" onClick={() => portal.refresh({ preserveVerified: true })}>Refresh portal reads</button>;
}

const openCompletedWithCache = (props = {}) => render(
  <PortalReadProvider enabled>
    <PortalRefreshButton />
    <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} {...props} />
  </PortalReadProvider>
);

function RemountableCompleted({ visitsProps = {} }) {
  const [shown, setShown] = React.useState(true);
  return <PortalReadProvider enabled>
    <button type="button" onClick={() => setShown(value => !value)}>{shown ? 'Close completed visits' : 'Reopen completed visits'}</button>
    {shown && <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} {...visitsProps} />}
  </PortalReadProvider>;
}

function SwitchableHistoryScope({ onSavedScopeUnavailable }) {
  const [scope, setScope] = React.useState('all');
  return <PortalReadProvider enabled>
    <button type="button" onClick={() => setScope('all')}>Show all cached history</button>
    <button type="button" onClick={() => setScope('pa')}>Show selected history</button>
    <ServicesTab key={scope} historyProperty={scope} customerId={customer.id} onSavedScopeUnavailable={onSavedScopeUnavailable} />
  </PortalReadProvider>;
}

describe('Completed visits by property', () => {
  it('opens the selected house, then shows retired and unassigned history in All properties', async () => {
    api.getServices.mockImplementation(async ({ historyProperty }) => ({
      historyProperty, historyCustomerId: customer.id,
      services: [{ id: 'record', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: historyProperty === 'all' ? 'Retired address' : 'Selected address' }],
      total: 1,
    }));
    openCompleted();
    expect(await screen.findByText('Selected address')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All properties on this profile' })).toHaveValue('all');
    fireEvent.change(screen.getByRole('combobox', { name: /Show completed visits for/ }), { target: { value: 'all' } });
    expect(screen.queryByText('Selected address')).not.toBeInTheDocument();
    expect(await screen.findByText('Retired address')).toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100, historyProperty: 'pa' });
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100, historyProperty: 'all' });
  });

  it('labels and requests profile-wide history when the current holder profile is positively closed', async () => {
    const closedSelection = { key: null, customerId: customer.id, propertyId: null, closed: true };
    api.getServices.mockResolvedValue({
      historyProperty: 'all', historyCustomerId: customer.id, total: 1,
      services: [{ id: 'retired', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Retired property address' }],
    });
    openCompleted({ properties: [], activePropertyId: customer.id, selectedProperty: closedSelection });

    expect(await screen.findByText('Retired property address')).toBeInTheDocument();
    const scope = screen.getByRole('combobox', { name: /Show completed visits for/ });
    expect(scope).toHaveValue('all');
    expect(scope).toBeDisabled();
    expect(screen.getByRole('option', { name: 'All properties on this profile' })).toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100, historyProperty: 'all' });
  });

  it('withholds records served for another property or by an older server', async () => {
    const refreshProperties = vi.fn();
    api.getServices.mockResolvedValue({ services: [{ id: 'wrong', type: 'Wrong house' }], historyProperty: 'pb', historyCustomerId: customer.id });
    openCompleted({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Wrong house')).not.toBeInTheDocument();
  });

  it('dedupes automatic picker refreshes but retries one after an explicit Try Again', async () => {
    const conflict = Object.assign(new Error('Your selected property changed.'), { status: 409 });
    const refreshProperties = vi.fn(() => Promise.reject(new Error('property list unavailable')));
    api.getServices.mockRejectedValue(conflict);
    openCompletedWithCache({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' }));
    await waitFor(() => expect(api.getServices).toHaveBeenCalledTimes(2));
    expect(refreshProperties).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(api.getServices).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(2));
  });

  it.each([401, 403])('clears cached rows and actions after pagination loses authorization (%s) without refreshing the picker', async status => {
    const refreshProperties = vi.fn();
    api.getServices
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'old', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached authorized house', reportUrl: '/report/old' }],
      })
      .mockRejectedValueOnce(Object.assign(new Error('Authorization denied'), { status }));
    render(<RemountableCompleted visitsProps={{ onSavedScopeUnavailable: refreshProperties }} />);
    expect(await screen.findByText('Cached authorized house')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pest/ }));
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    expect(screen.queryByText('Cached authorized house')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(refreshProperties).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close completed visits' }));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen completed visits' }));
    expect(screen.queryByText('Cached authorized house')).not.toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledTimes(2);
  });

  it('rearms automatic picker recovery after wrong echo, matching verification, then another wrong echo', async () => {
    const refreshProperties = vi.fn();
    api.getServices
      .mockResolvedValueOnce({ services: [{ id: 'wrong-1', type: 'Wrong first house' }], historyProperty: 'pb', historyCustomerId: customer.id })
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'verified', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Verified selected house' }],
      })
      .mockResolvedValueOnce({ services: [{ id: 'wrong-2', type: 'Wrong later house' }], historyProperty: 'pb', historyCustomerId: customer.id });
    openCompletedWithCache({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' }));
    expect(await screen.findByText('Verified selected house')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    expect(screen.queryByText('Wrong later house')).not.toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(2));
  });

  it('refreshes the picker only for the distinct property-history 403 code', async () => {
    const refreshProperties = vi.fn();
    const unavailable = Object.assign(new Error('Property history is unavailable for this session.'), {
      status: 403,
      code: 'PROPERTY_HISTORY_UNAVAILABLE',
    });
    api.getServices.mockRejectedValueOnce(unavailable);
    openCompleted({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));

    cleanup();
    vi.clearAllMocks();
    api.getServices.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    openCompleted({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    expect(refreshProperties).not.toHaveBeenCalled();
  });

  it('clears every provider cache key on the coded property-history 403', async () => {
    const refreshProperties = vi.fn(() => Promise.reject(new Error('property list unavailable')));
    api.getServices.mockImplementation(({ historyProperty }) => {
      if (historyProperty === 'all') return Promise.resolve({
        historyProperty: 'all', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'retired', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached retired house' }],
      });
      return Promise.reject(Object.assign(new Error('Property history is unavailable for this session.'), {
        status: 403,
        code: 'PROPERTY_HISTORY_UNAVAILABLE',
      }));
    });
    render(<SwitchableHistoryScope onSavedScopeUnavailable={refreshProperties} />);
    expect(await screen.findByText('Cached retired house')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show selected history' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Show all cached history' }));
    expect(screen.queryByText('Cached retired house')).not.toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledTimes(2);
  });

  it('keeps other provider cache keys after a 409 invalidates only the active scope', async () => {
    const refreshProperties = vi.fn(() => Promise.reject(new Error('property list unavailable')));
    api.getServices.mockImplementation(({ historyProperty }) => {
      if (historyProperty === 'all') return Promise.resolve({
        historyProperty: 'all', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'retired', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached retired house' }],
      });
      return Promise.reject(Object.assign(new Error('Your selected property changed.'), { status: 409 }));
    });
    render(<SwitchableHistoryScope onSavedScopeUnavailable={refreshProperties} />);
    expect(await screen.findByText('Cached retired house')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show selected history' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Show all cached history' }));

    expect(screen.getByText('Cached retired house')).toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 409', () => Promise.reject(Object.assign(new Error('Your selected property changed.'), { status: 409 }))],
    ['a wrong property echo', () => Promise.resolve({ services: [{ id: 'wrong', type: 'Wrong house' }], historyProperty: 'pb', historyCustomerId: customer.id, total: 2 })],
  ])('hides cached rows, report actions, and pagination after %s until a matching retry verifies the scope', async (_label, conflictPage) => {
    const refreshProperties = vi.fn();
    api.getServices
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'old', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached house', reportUrl: '/report/old' }],
      })
      .mockImplementationOnce(conflictPage)
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'verified', status: 'completed', date: '2026-01-11', type: 'Lawn', propertyAddress: 'Verified house' }],
      });
    openCompletedWithCache({ onSavedScopeUnavailable: refreshProperties });

    expect(await screen.findByText('Cached house')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pest/ }));
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));

    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    expect(screen.queryByText('Cached house')).not.toBeInTheDocument();
    expect(screen.queryByText('Wrong house')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load More Visits' })).not.toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Verified house')).toBeInTheDocument();
    expect(screen.queryByText('Cached house')).not.toBeInTheDocument();
  });

  it('denies an initial refresh completion that started before a pagination conflict', async () => {
    let resolveStaleRefresh;
    const refreshProperties = vi.fn();
    api.getServices
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'old', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached house' }],
      })
      .mockImplementationOnce(() => new Promise(resolve => { resolveStaleRefresh = resolve; }))
      .mockRejectedValueOnce(Object.assign(new Error('Your selected property changed.'), { status: 409 }))
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'verified', status: 'completed', date: '2026-01-12', type: 'Mosquito', propertyAddress: 'Verified after conflict' }],
      });
    openCompletedWithCache({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('Cached house')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' }));
    await waitFor(() => expect(api.getServices).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();

    await act(async () => {
      resolveStaleRefresh({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 1,
        services: [{ id: 'stale', status: 'completed', date: '2026-01-11', type: 'Lawn', propertyAddress: 'Stale completion' }],
      });
    });
    expect(screen.getByText('Could not load service history')).toBeInTheDocument();
    expect(screen.queryByText('Stale completion')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Verified after conflict')).toBeInTheDocument();
    expect(refreshProperties).toHaveBeenCalledTimes(1);
  });

  it('ignores an older background 409 after a newer pagination read verifies the same scope', async () => {
    let rejectOlderRefresh;
    let backgroundRefresh = false;
    const refreshProperties = vi.fn();
    api.getServices.mockImplementation(({ offset } = {}) => {
      if (offset != null) return Promise.resolve({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'second', status: 'completed', date: '2026-01-09', type: 'Lawn', propertyAddress: 'Newer verified page' }],
      });
      if (backgroundRefresh) return new Promise((_resolve, reject) => { rejectOlderRefresh = reject; });
      return Promise.resolve({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'first', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'First verified visit' }],
      });
    });
    openCompletedWithCache({ onSavedScopeUnavailable: refreshProperties });
    expect(await screen.findByText('First verified visit')).toBeInTheDocument();

    backgroundRefresh = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' }));
    await waitFor(() => expect(rejectOlderRefresh).toEqual(expect.any(Function)));
    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));
    expect(await screen.findByText('Newer verified page')).toBeInTheDocument();

    await act(async () => {
      rejectOlderRefresh(Object.assign(new Error('Your selected property changed.'), { status: 409 }));
    });
    expect(screen.getByText('First verified visit')).toBeInTheDocument();
    expect(screen.getByText('Newer verified page')).toBeInTheDocument();
    expect(screen.queryByText('Could not load service history')).not.toBeInTheDocument();
    expect(refreshProperties).not.toHaveBeenCalled();
  });

  it('does not recover invalidated history from cache after a failed picker refresh, unmount, and offline remount', async () => {
    const refreshProperties = vi.fn(() => Promise.reject(new Error('property list unavailable')));
    api.getServices
      .mockResolvedValueOnce({
        historyProperty: 'pa', historyCustomerId: customer.id, total: 2,
        services: [{ id: 'old', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: 'Cached house' }],
      })
      .mockRejectedValueOnce(Object.assign(new Error('Your selected property changed.'), { status: 409 }));
    render(<RemountableCompleted visitsProps={{ onSavedScopeUnavailable: refreshProperties }} />);
    expect(await screen.findByText('Cached house')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Close completed visits' }));

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen completed visits' }));

    expect(screen.queryByText('Cached house')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load More Visits' })).not.toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledTimes(2);
  });

  it('does not refresh the picker or publish stale history after the page unmounts', async () => {
    let resolveHistory;
    const refreshProperties = vi.fn();
    api.getServices.mockImplementation(() => new Promise(resolve => { resolveHistory = resolve; }));
    const view = openCompleted({ onSavedScopeUnavailable: refreshProperties });
    await waitFor(() => expect(api.getServices).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolveHistory({ services: [{ id: 'wrong', type: 'Wrong house' }], historyProperty: 'pb', historyCustomerId: customer.id });
    });
    expect(refreshProperties).not.toHaveBeenCalled();
    expect(screen.queryByText('Wrong house')).not.toBeInTheDocument();
  });

  it.each([
    { properties: profileShaped, activePropertyId: 'cust-1' },
    { customer: { ...customer, actor: { kind: 'contact' } } },
    { customer: { ...customer, cancelled: true } },
    { properties: [], activePropertyId: customer.id, selectedProperty: { key: null, customerId: customer.id, propertyId: null, closed: true }, customer: { ...customer, actor: { kind: 'contact' } } },
    { properties: [], activePropertyId: customer.id, selectedProperty: { key: null, customerId: 'another-profile', propertyId: null, closed: true } },
    { properties: [], activePropertyId: 'another-profile', selectedProperty: { key: null, customerId: customer.id, propertyId: null, closed: true } },
  ])('keeps the existing read path when property history is unavailable', async (props) => {
    openCompleted(props);
    expect(await screen.findByText('No completed visits yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Show completed visits for/ })).not.toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100 });
  });
});
