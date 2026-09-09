// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TechProtocolsPage from './TechProtocolsPage';
import TechLawnDiagnosticPage from './TechLawnDiagnosticPage';
import TechSocialPostPage from './TechSocialPostPage';

function Destination() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([TechProtocolsPage, TechLawnDiagnosticPage, TechSocialPostPage])('embedded %s Back retains the selected visit', async Page => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ photos: [], locations: [], enabled: true }) })));
  render(<MemoryRouter initialEntries={['/tech/tool?visit=visit%3Agroup']}><Routes>
    <Route path="/tech/tool" element={<Page />} /><Route path="/tech" element={<Destination />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '← Back', exact: true }));
  expect(screen.getByRole('status')).toHaveTextContent('/tech?visit=visit%3Agroup');
});
