// @vitest-environment jsdom
// Truck check (GATE_TRUCK_KIT) in the field workspace: the Tools tile and the
// Today card follow one status read; gate off or unreadable, neither renders.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ truckKit: { loading: false, data: null, error: '' } }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: () => null }));
vi.mock('../../components/tech/useTruckKit', () => ({ default: () => mocks.truckKit, lastCheckedLabel: () => 'Never checked' }));
import TechHomePage from './TechHomePage';

function mount(path) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ setNavigationBusy: vi.fn(), techRole: 'technician' }} />}>
      <Route index element={<TechHomePage />} />
      <Route path="tools" element={<TechHomePage section="tools" />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    const data = String(path).includes('/admin/schedule?') ? { services: [] } : {};
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('truck check in the field workspace', () => {
  it('shows the Tools tile and the Today card when the kit is on and a check is due', async () => {
    mocks.truckKit = { loading: false, error: '', data: { enabled: true, truck: { id: 'v1', name: 'Synthetic truck' }, kit: [{ id: 'e1' }], lastCheck: null, due: true } };
    mount('/admin/today/tools');
    expect(await screen.findByRole('button', { name: /Truck check/ })).toBeInTheDocument();
    cleanup();
    mount('/admin/today');
    expect(await screen.findByText('Truck check due')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check truck' })).toHaveAttribute('href', '/admin/today/truck-check');
  });

  it('keeps both away when the gate is off, and the card away when nothing is due', async () => {
    mocks.truckKit = { loading: false, error: '', data: { enabled: false } };
    mount('/admin/today/tools');
    expect(await screen.findByRole('button', { name: /Protocols & SOPs/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Truck check/ })).not.toBeInTheDocument();
    cleanup();
    mocks.truckKit = { loading: false, error: '', data: { enabled: true, truck: { id: 'v1', name: 'Synthetic truck' }, kit: [{ id: 'e1' }], lastCheck: { checked_at: '2026-10-22T12:00:00Z' }, due: false } };
    mount('/admin/today');
    expect(await screen.findByText('Shift time')).toBeInTheDocument();
    expect(screen.queryByText('Truck check due')).not.toBeInTheDocument();
  });
});
