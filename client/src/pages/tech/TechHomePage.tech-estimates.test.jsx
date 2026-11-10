// @vitest-environment jsdom
// The technician estimate tool in the field workspace (GATE_TECH_ESTIMATES): the setup is read once, and while the
// server answers 404 { enabled: false } (gate off, or this technician's switch off) nothing of the tool shows
// and nothing else of it is requested.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechEstimateSheet', () => ({ default: () => <div role="dialog" aria-label="Estimate sheet" /> }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: () => null }));
vi.mock('../../components/tech/useTruckKit', () => ({ default: () => ({ loading: false, data: null, error: '', reload: () => {} }), lastCheckedLabel: () => '' }));
import TechHomePage from './TechHomePage';

let setupAnswer;
let toolCalls;
function mount() {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={['/admin/today/tools']}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ setNavigationBusy: vi.fn(), techRole: 'technician' }} />}>
      <Route path="tools" element={<TechHomePage section="tools" />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  toolCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    const url = String(path);
    if (url.includes('/api/tech/estimates')) {
      toolCalls.push(url);
      return { ok: setupAnswer.status < 400, status: setupAnswer.status, json: async () => setupAnswer.body };
    }
    return { ok: true, status: 200, json: async () => (url.includes('/admin/schedule?') ? { services: [] } : {}) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('technician estimate tool in the field workspace', () => {
  // Off is a plain 200 { enabled: false } from the setup read; an older server (or any failure) answers 404.
  it.each([
    ['200 enabled:false', { status: 200, body: { enabled: false } }],
    ['404 enabled:false', { status: 404, body: { enabled: false } }],
  ])('shows no entry and requests nothing more while the server answers %s', async (_label, answer) => {
    setupAnswer = answer;
    mount();
    expect(await screen.findByRole('button', { name: /Protocols & SOPs/ })).toBeInTheDocument();
    await waitFor(() => expect(toolCalls).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /Estimates/ })).not.toBeInTheDocument();
    expect(toolCalls).toEqual(['/api/tech/estimates/setup']);
  });

  it('shows no entry when setup lists no service he may quote', async () => {
    setupAnswer = { status: 200, body: { enabled: true, services: [] } };
    mount();
    await screen.findByRole('button', { name: /Protocols & SOPs/ });
    await waitFor(() => expect(toolCalls).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /Estimates/ })).not.toBeInTheDocument();
  });

  it('shows the general entry once setup lists a service, and it opens the sheet', async () => {
    setupAnswer = { status: 200, body: { enabled: true, oneTimeHoldDollars: 1000, services: [{ key: 'PEST', label: 'Recurring pest control', category: 'pest' }] } };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Estimates/ }));
    expect(await screen.findByRole('dialog', { name: 'Estimate sheet' })).toBeInTheDocument();
    expect(toolCalls).toEqual(['/api/tech/estimates/setup']);
  });
});
