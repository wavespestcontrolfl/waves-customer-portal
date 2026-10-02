// @vitest-environment jsdom
import React, { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const flag = vi.hoisted(() => ({ enabled: true, ready: true }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => flag }));
vi.mock('./AddToHomeScreenHint', () => ({ default: () => <p>Install hint</p> }));
import TechFieldShell from './TechFieldShell';
import TechNavigationLock from './TechNavigationLock';
const unmounted = vi.fn();
beforeEach(() => { flag.enabled = true; flag.ready = true; });
function Visit() {
  const { setNavigationBusy } = useOutletContext();
  useEffect(() => unmounted, []);
  return <><button onClick={() => setNavigationBusy(true)}>Start contact</button><button onClick={() => setNavigationBusy(false)}>Settle contact</button></>;
}
afterEach(() => { cleanup(); unmounted.mockClear(); window.history.replaceState({}, '', '/'); });

function renderShell(path = '/admin/today', documentsAvailable = false) {
  return render(<TechNavigationLock><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" documentsAvailable={documentsAvailable}><div>Existing route</div></TechFieldShell>}>
      <Route index element={<div>Route content</div>} />
      <Route path="tools" element={<div>Tools content</div>} />
      <Route path="more" element={<div>More content</div>} />
      <Route path="protocols" element={<div>Protocols content</div>} />
      <Route path="documents" element={<div>Protected staff documents</div>} />
    </Route>
  </Routes></MemoryRouter></TechNavigationLock>);
}

it('uses the existing route when disabled and waits for an unresolved flag', () => {
  flag.enabled = false;
  const mounted = renderShell();
  expect(screen.getByText('Existing route')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Field navigation' })).not.toBeInTheDocument();
  mounted.unmount();
  flag.ready = false;
  renderShell();
  expect(screen.getByRole('status')).toHaveTextContent('Loading field workspace');
  expect(screen.queryByText('Route content')).not.toBeInTheDocument();
});

it('the flag-off view keeps the install hint the retired /tech shell showed (Codex #5573 r8)', () => {
  flag.enabled = false;
  renderShell();
  expect(screen.getByText('Install hint')).toBeInTheDocument();
  expect(screen.getByText('Existing route')).toBeInTheDocument();
});

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

it('opening a visit (?visit= only) scrolls the field main back to the top (Codex #5573 r15)', async () => {
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  function Go() { const { setNavigationBusy } = useOutletContext(); void setNavigationBusy; return <Link to="/admin/today?visit=row%3Aone">Open stop</Link>; }
  render(<TechNavigationLock><MemoryRouter initialEntries={['/admin/today']}><Routes>
    <Route path="/admin/today" element={<TechFieldShell techName="Fixture Tech" documentsAvailable={false}><div>Existing route</div></TechFieldShell>}>
      <Route index element={<Go />} />
    </Route>
  </Routes></MemoryRouter></TechNavigationLock>);
  const before = scrollTo.mock.calls.length;
  fireEvent.click(screen.getByRole('link', { name: 'Open stop' }));
  await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(before));
});
