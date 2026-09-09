// @vitest-environment jsdom
import React, { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const flag = vi.hoisted(() => ({ enabled: true, ready: true }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => flag }));
vi.mock('./AddToHomeScreenHint', () => ({ default: () => null }));
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

function renderShell(path = '/tech', documentsAvailable = false) {
  return render(<TechNavigationLock><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tech" element={<TechFieldShell techName="Fixture Tech" documentsAvailable={documentsAvailable}><div>Existing route</div></TechFieldShell>}>
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

it.each(['/tech/documents', '/tech/documents/', '/TECH/DOCUMENTS/'])('keeps documents gated at %s', (path) => {
  const mounted = renderShell(path);
  expect(screen.getByText('Staff documents are unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Protected staff documents')).not.toBeInTheDocument();
  mounted.unmount();
  renderShell(path, true);
  expect(screen.getByText('Protected staff documents')).toBeInTheDocument();
});

it.each([
  ['/tech/', 'Today', false], ['/TECH/', 'Today', false],
  ['/tech/tools/', 'Tools', true], ['/TECH/TOOLS/', 'Tools', true],
  ['/tech/more/', 'More', true], ['/TECH/MORE/', 'More', true],
  ['/TECH/PROTOCOLS/', 'Tools', true],
])('retains navigation and visit context at %s', (path, section, returnVisible) => {
  renderShell(`${path}?visit=row%3Atwo`);
  expect(screen.getByRole('link', { name: section, exact: true })).toHaveAttribute('aria-current', 'page');
  expect(Boolean(screen.queryByRole('link', { name: 'Return to visit' }))).toBe(returnVisible);
  expect(screen.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('href', '/tech?visit=row%3Atwo');
  expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('href', '/tech/tools?visit=row%3Atwo');
  expect(screen.queryByText('Messages')).not.toBeInTheDocument();
});
it('keeps a busy visit mounted on browser Back and permits Back after settlement', async () => {
  window.history.replaceState({ idx: 0 }, '', '/tech');
  render(<TechNavigationLock><BrowserRouter future={{ v7_startTransition: true }}><Routes><Route path="/tech" element={<TechFieldShell techName="Fixture Tech" />}>
    <Route index element={<Link to="/tech/visit">Open visit</Link>} /><Route path="visit" element={<Visit />} />
  </Route></Routes></BrowserRouter></TechNavigationLock>);
  fireEvent.click(screen.getByRole('link', { name: 'Open visit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Start contact' }));
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(window.location.pathname).toBe('/tech/visit'));
  // Wait for the restored POP entry, not just the initial synchronous URL.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(window.location.pathname).toBe('/tech/visit');
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Settle contact' }));
  await act(async () => { window.history.back(); });
  expect(await screen.findByRole('link', { name: 'Open visit' })).toBeInTheDocument();
  expect(unmounted).toHaveBeenCalledTimes(1);
});
