// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import TechNavigationLock from '../../components/tech/TechNavigationLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ shellEnabled: false, shellReads: [] }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: (key) => key === 'pest-recap-v1',
  useFeatureFlagReady: (key) => { flags.shellReads.push(key); return { enabled: flags.shellEnabled, ready: true }; },
}));
vi.mock('../../hooks/useStaffDocumentsAvailable', () => ({ default: () => true }));
vi.mock('../../hooks/usePayGrowthAvailable', () => ({ default: () => true }));
vi.mock('../../components/tech/AddToHomeScreenHint', () => ({ default: () => null }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/GeofenceArrivalPrompt', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('../tech/VisitBriefPanel', () => ({ default: ({ stop }) => <p>Property brief for {stop.primary.id}</p> }));
vi.mock('./ProjectsPage', () => ({ ProjectDetail: () => null }));
import TodayShell from './TodayShell';
import TechHomePage from '../tech/TechHomePage';

const TECH = { id: 't1', name: 'Fixture Tech', role: 'technician' };
const row = (id) => ({ id, technicianId: 't1', customerName: `Fixture ${id}`, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00' });

function Where() { const { pathname, search } = useLocation(); return <output data-testid="where">{pathname}{search}</output>; }

function mount(path = '/admin/today') {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify(TECH));
  // App.jsx mounts the one navigation lock OUTSIDE the router; the shell reads it.
  return render(<TechNavigationLock><MemoryRouter initialEntries={[path]}><Where /><Routes>
    <Route path="/admin" element={<Outlet context={{ user: TECH }} />}>
      <Route path="today" element={<TodayShell />}>
        <Route index element={<TechHomePage />} />
        <Route path="tools" element={<TechHomePage section="tools" />} />
        <Route path="more" element={<TechHomePage section="more" />} />
        <Route path="protocols" element={<div>Protocols page</div>} />
      </Route>
      <Route path="more" element={<div>Admin menu page</div>} />
    </Route>
    <Route path="/tech/*" element={<div>Legacy tech shell</div>} />
  </Routes></MemoryRouter></TechNavigationLock>);
}

beforeEach(() => {
  flags.shellEnabled = true;
  flags.shellReads.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    let data = {};
    if (path.includes('/admin/schedule?')) data = { services: [row('one'), row('two')] };
    if (path.includes('/tech/line')) data = { line: null };
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('/admin/today field shell', () => {
  it('renders the embedded field workspace with Today, Tools, More and Menu', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Field navigation' });
    expect(nav.textContent).toMatch(/Today.*Tools.*More.*Menu/);
    expect(screen.getByText('Fixture Tech')).toBeInTheDocument();
    expect(document.querySelector('.tech-field.tf-embedded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/admin/today');
    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('href', '/admin/today/tools');
    expect(screen.getByRole('link', { name: 'More' })).toHaveAttribute('href', '/admin/today/more');
    expect(screen.getByRole('link', { name: 'Menu' })).toHaveAttribute('href', '/admin/more');
    expect(screen.getByRole('link', { name: 'Waves Tech Today' })).toHaveAttribute('href', '/admin/today');
    // Field workspace content, not the legacy dark route UI.
    expect(await screen.findByRole('button', { name: 'Open visit' })).toBeInTheDocument();
  });

  it('honors the tech-field-workspace flag: off renders the legacy route UI inside admin', async () => {
    flags.shellEnabled = false;
    mount();
    expect(await screen.findByText("Today's Route")).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Field navigation' })).not.toBeInTheDocument();
    expect(flags.shellReads).toContain('tech-field-workspace');
    expect(document.querySelector('[data-legacy-field-shell]')).not.toBeNull();
  });

  it('Menu leaves the workspace for the admin menu', async () => {
    mount();
    fireEvent.click(await screen.findByRole('link', { name: 'Menu' }));
    expect(await screen.findByText('Admin menu page')).toBeInTheDocument();
  });

  it('opening a stop stays inside /admin/today', async () => {
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open visit' }))[0]);
    await screen.findByText(/Property brief for/);
    const where = screen.getByTestId('where').textContent;
    expect(where).toMatch(/^\/admin\/today\?visit=/);
    expect(where).not.toMatch(/^\/tech/);
    expect(screen.queryByText('Legacy tech shell')).not.toBeInTheDocument();
  });

  it('keeps the visit selection on in-workspace nav links', async () => {
    mount('/admin/today/tools?visit=row%3Atwo');
    expect(await screen.findByRole('link', { name: 'Today' })).toHaveAttribute('href', '/admin/today?visit=row%3Atwo');
    expect(screen.getByRole('link', { name: 'Return to visit' })).toHaveAttribute('href', '/admin/today?visit=row%3Atwo');
    expect(screen.getByRole('link', { name: 'Menu' })).toHaveAttribute('href', '/admin/more');
  });
});
