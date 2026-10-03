// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TechProtocolsPage from './TechProtocolsPage';
import TechLawnDiagnosticPage from './TechLawnDiagnosticPage';
import TechSocialPostPage from './TechSocialPostPage';
import { TechBasePathContext } from '../../components/tech/techBasePath';

function Destination() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([TechProtocolsPage, TechLawnDiagnosticPage, TechSocialPostPage])('embedded %s Back retains the selected visit', async Page => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ photos: [], locations: [], enabled: true }) })));
  render(<MemoryRouter initialEntries={['/admin/today/tool?visit=visit%3Agroup']}><Routes>
    <Route path="/admin/today/tool" element={<Page />} /><Route path="/admin/today" element={<Destination />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '← Back', exact: true }));
  expect(screen.getByRole('status')).toHaveTextContent('/admin/today?visit=visit%3Agroup');
});

it.each([TechProtocolsPage, TechLawnDiagnosticPage, TechSocialPostPage])('%s Back goes to the workspace base path when mounted at /admin/today', async Page => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ photos: [], locations: [], enabled: true }) })));
  render(<TechBasePathContext.Provider value="/admin/today"><MemoryRouter initialEntries={['/admin/today/tool?visit=visit%3Agroup']}><Routes>
    <Route path="/admin/today/tool" element={<Page />} /><Route path="/admin/today" element={<Destination />} />
  </Routes></MemoryRouter></TechBasePathContext.Provider>);
  fireEvent.click(await screen.findByRole('button', { name: '← Back', exact: true }));
  expect(screen.getByRole('status')).toHaveTextContent('/admin/today?visit=visit%3Agroup');
});
