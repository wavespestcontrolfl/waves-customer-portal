// @vitest-environment jsdom
import React, { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./AddToHomeScreenHint', () => ({ default: () => <p>Install hint</p> }));
import TechFieldShell from './TechFieldShell';
import TechNavigationLock from './TechNavigationLock';
const unmounted = vi.fn();
function Visit() {
  const { setNavigationBusy } = useOutletContext();
  useEffect(() => unmounted, []);
  return <><button onClick={() => setNavigationBusy(true)}>Start contact</button><button onClick={() => setNavigationBusy(false)}>Settle contact</button></>;
}
afterEach(() => { cleanup(); unmounted.mockClear(); window.history.replaceState({}, '', '/'); });

function renderShell(path = '/admin/today', documentsAvailable = false) {
  return render(<TechNavigationLock><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" documentsAvailable={documentsAvailable} />}>
      <Route index element={<div>Route content</div>} />
      <Route path="tools" element={<div>Tools content</div>} />
      <Route path="more" element={<div>More content</div>} />
      <Route path="protocols" element={<div>Protocols content</div>} />
      <Route path="documents" element={<div>Protected staff documents</div>} />
    </Route>
  </Routes></MemoryRouter></TechNavigationLock>);
}

it.each(['/admin/today/documents', '/admin/today/documents/', '/ADMIN/TODAY/DOCUMENTS/'])('keeps documents gated at %s', (path) => {
  const mounted = renderShell(path);
  expect(screen.getByText('Staff documents are unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Protected staff documents')).not.toBeInTheDocument();
  mounted.unmount();
  renderShell(path, true);
  expect(screen.getByText('Protected staff documents')).toBeInTheDocument();
});

it.each([
  ['/admin/today/', 'Today', false], ['/ADMIN/TODAY/', 'Today', false],
  ['/admin/today/tools/', 'Tools', true], ['/ADMIN/TODAY/TOOLS/', 'Tools', true],
  ['/admin/today/more/', 'More', true], ['/ADMIN/TODAY/MORE/', 'More', true],
  ['/ADMIN/TODAY/PROTOCOLS/', 'Tools', true],
])('retains navigation and visit context at %s', (path, section, returnVisible) => {
  renderShell(`${path}?visit=row%3Atwo`);
  expect(screen.getByRole('link', { name: section, exact: true })).toHaveAttribute('aria-current', 'page');
  expect(Boolean(screen.queryByRole('link', { name: 'Return to visit' }))).toBe(returnVisible);
  expect(screen.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('href', '/admin/today?visit=row%3Atwo');
  expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('href', '/admin/today/tools?visit=row%3Atwo');
  expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'More' })).toHaveAttribute('href', `/admin/today/more?visit=row%3Atwo`);
});
it('shows a Today, Tools, More tab row and no header or bottom bar of its own (owner 2026-10-05)', () => {
  renderShell('/admin/today/tools');
  const tabs = screen.getByRole('navigation', { name: 'Field sections' });
  expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Today', 'Tools', 'More']);
  expect(within(tabs).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/admin/today', '/admin/today/tools', '/admin/today/more']);
  expect(screen.queryByRole('navigation', { name: 'Field navigation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Menu' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Waves Tech Today' })).not.toBeInTheDocument();
  expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  // The admin shell owns the one <main>.
  expect(screen.queryByRole('main')).not.toBeInTheDocument();
});
it('holds the tab links while a visit action is in flight and frees them after', () => {
  render(<TechNavigationLock><MemoryRouter initialEntries={['/admin/today/tools']}><Routes>
    <Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" />}>
      <Route index element={<div>Route content</div>} />
      <Route path="tools" element={<Visit />} />
    </Route>
  </Routes></MemoryRouter></TechNavigationLock>);
  fireEvent.click(screen.getByRole('button', { name: 'Start contact' }));
  const today = screen.getByRole('link', { name: 'Today' });
  expect(today).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(today);
  expect(screen.queryByText('Route content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Settle contact' }));
  expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-disabled', 'false');
  fireEvent.click(screen.getByRole('link', { name: 'Today' }));
  expect(screen.getByText('Route content')).toBeInTheDocument();
});
it('keeps a busy visit mounted on browser Back and permits Back after settlement', async () => {
  window.history.replaceState({ idx: 0 }, '', '/admin/today');
  render(<TechNavigationLock><BrowserRouter future={{ v7_startTransition: true }}><Routes><Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" />}>
    <Route index element={<Link to="/admin/today/visit">Open visit</Link>} /><Route path="visit" element={<Visit />} />
  </Route></Routes></BrowserRouter></TechNavigationLock>);
  fireEvent.click(screen.getByRole('link', { name: 'Open visit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Start contact' }));
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(window.location.pathname).toBe('/admin/today/visit'));
  // Wait for the restored POP entry, not just the initial synchronous URL.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(window.location.pathname).toBe('/admin/today/visit');
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Settle contact' }));
  await act(async () => { window.history.back(); });
  expect(await screen.findByRole('link', { name: 'Open visit' })).toBeInTheDocument();
  await waitFor(() => expect(unmounted).toHaveBeenCalledTimes(1));
});

it('protects document departure without a router history index only while busy', () => {
  render(<TechNavigationLock><MemoryRouter><Routes><Route element={<TechFieldShell techName="Fixture Tech" />}>
    <Route index element={<Visit />} />
  </Route></Routes></MemoryRouter></TechNavigationLock>);
  fireEvent.click(screen.getByRole('button', { name: 'Start contact' }));
  const busyDeparture = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(busyDeparture);
  expect(busyDeparture.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Settle contact' }));
  const settledDeparture = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(settledDeparture);
  expect(settledDeparture.defaultPrevented).toBe(false);
});

it('opening a visit (?visit= only) scrolls the admin main back to the top (Codex #5573 r15)', async () => {
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  function Go() { const { setNavigationBusy } = useOutletContext(); void setNavigationBusy; return <Link to="/admin/today?visit=row%3Aone">Open stop</Link>; }
  // The page scrolls in the admin main area, which wraps the workspace.
  render(<div className="admin-main"><TechNavigationLock><MemoryRouter initialEntries={['/admin/today']}><Routes>
    <Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" documentsAvailable={false} />}>
      <Route index element={<Go />} />
    </Route>
  </Routes></MemoryRouter></TechNavigationLock></div>);
  const before = scrollTo.mock.calls.length;
  fireEvent.click(screen.getByRole('link', { name: 'Open stop' }));
  await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(before));
});
