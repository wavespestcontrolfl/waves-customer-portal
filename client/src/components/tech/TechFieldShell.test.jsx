// @vitest-environment jsdom
import React, { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Link, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => ({ enabled: true, ready: true }) }));
vi.mock('./AddToHomeScreenHint', () => ({ default: () => null }));
import TechFieldShell from './TechFieldShell';
import TechNavigationLock from './TechNavigationLock';
const unmounted = vi.fn();
function Visit() {
  const { setNavigationBusy } = useOutletContext();
  useEffect(() => unmounted, []);
  return <><button onClick={() => setNavigationBusy(true)}>Start contact</button><button onClick={() => setNavigationBusy(false)}>Settle contact</button></>;
}
afterEach(() => { cleanup(); unmounted.mockClear(); window.history.replaceState({}, '', '/'); });
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
