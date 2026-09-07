// @vitest-environment jsdom
// A plain price/notes edit must not rewrite the visit's stored service type
// (UI audit 2026-09-07, SMS-01): only a tier the tech changed does.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileServiceEditModal from './MobileServiceEditModal';

const SERVICE = {
  id: 'svc-1',
  serviceType: 'Lawn Care - Track B',
  estimatedPrice: 99,
  technicianId: '',
  estimatedDuration: 30,
  notes: '',
};

function lastPutBody() {
  const call = fetch.mock.calls.find(([url, opts]) => String(url).endsWith('/admin/schedule/svc-1/update-details') && opts?.method === 'PUT');
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

describe('MobileServiceEditModal save payload', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('omits serviceType when the tech did not pick a different tier', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = lastPutBody();
    expect(body).not.toHaveProperty('serviceType');
    expect(body.estimatedPrice).toBe(99);
  });

  it('rewrites serviceType only from a tier the tech chose', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Quarterly/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastPutBody().serviceType).toBe('Lawn Care - Track B — Quarterly');
  });
});
