// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('../../native/platform', () => ({ isNativeApp: () => platform.native }));
vi.mock('./AddToHomeScreenHint', () => ({ default: () => <p>Install hint</p> }));
import TechPortalRedirect from './TechPortalRedirect';

function Where() { const { pathname, search, hash } = useLocation(); return <output>{pathname}{search}{hash}</output>; }
function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tech/*" element={<TechPortalRedirect />} />
    <Route path="*" element={<Where />} />
  </Routes></MemoryRouter>);
}
beforeEach(() => { localStorage.setItem('waves_admin_token', 'fixture-only'); });
afterEach(() => { cleanup(); platform.native = false; localStorage.clear(); });

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

  it('signed out: shows the Field Tools page with the install hint and a sign-in link back to Today (Codex #5573 r10)', () => {
    localStorage.clear();
    renderAt('/tech/tools?visit=row%3Atwo');
    expect(screen.getByText('Install hint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/admin/login?next=${encodeURIComponent('/admin/today/tools?visit=row%3Atwo')}`);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Waves Field Tools' }).parentElement.style.paddingTop).toContain('safe-area-inset-top');
  });

  it('the signed-out landing carries the Field Tools install identity while mounted (Codex #5573 r16)', () => {
    localStorage.clear();
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json"><meta name="apple-mobile-web-app-title" content="Waves"><meta name="theme-color" content="#111111">';
    document.title = 'Waves Customer Portal';
    const view = renderAt('/tech');
    expect(document.querySelector('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.tech.json');
    expect(document.title).toBe('Waves Tech');
    view.unmount();
    expect(document.querySelector('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.json');
    expect(document.title).toBe('Waves Customer Portal');
  });
});
