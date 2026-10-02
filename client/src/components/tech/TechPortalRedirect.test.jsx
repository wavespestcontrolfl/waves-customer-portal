// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('../../native/platform', () => ({ isNativeApp: () => platform.native }));
import TechPortalRedirect from './TechPortalRedirect';

function Where() { const { pathname, search, hash } = useLocation(); return <output>{pathname}{search}{hash}</output>; }
function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tech/*" element={<TechPortalRedirect />} />
    <Route path="*" element={<Where />} />
  </Routes></MemoryRouter>);
}
afterEach(() => { cleanup(); platform.native = false; });

describe('retired /tech portal redirect', () => {
  it.each([
    ['/tech', '/admin/today'],
    ['/tech/', '/admin/today'],
    ['/tech?visit=row%3Atwo', '/admin/today?visit=row%3Atwo'],
    ['/tech/tools?visit=row%3Atwo', '/admin/today/tools?visit=row%3Atwo'],
    ['/tech/protocols#x', '/admin/today/protocols#x'],
    ['/tech/pay-growth?month=2026-09#score', '/admin/today/pay-growth?month=2026-09#score'],
    ['/TECH/Documents', '/admin/today/Documents'],
  ])('maps %s to %s', (from, to) => {
    renderAt(from);
    expect(screen.getByRole('status')).toHaveTextContent(to);
    expect(screen.getByRole('status').textContent).toBe(to);
  });

  it('sends the native app to the customer root instead', () => {
    platform.native = true;
    renderAt('/tech/tools');
    expect(screen.getByRole('status').textContent).toBe('/');
  });
});
