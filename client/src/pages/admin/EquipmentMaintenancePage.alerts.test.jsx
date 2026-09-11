// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';
const ok = body => ({ ok: true, json: async () => body });
const alerts = [
 { id: 'a1', severity: 'critical', title: 'Engine overheating' },
 { id: 'a2', severity: 'high', title: 'Brake wear' },
 { id: 'a3', severity: 'medium', title: 'Filter due' },
 { id: 'a4', severity: 'low', title: 'Wash reminder' },
];
beforeEach(() => {
 vi.stubGlobal('fetch', vi.fn(async url => {
  const u = String(url);
  if (u.includes('/alerts')) return ok({ alerts });
  if (u.includes('/analytics/overview')) return ok({});
  if (u.includes('/analytics/')) return ok({});
  return ok({ equipment: [] });
 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('renders fleet alert badges with severity-mapped tones', async () => {
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 await screen.findByText(/4 Active Alerts/);
 const tone = label => screen.getByText(label).className;
 expect(tone('critical')).toContain('text-alert-fg');
 expect(tone('high')).toContain('text-alert-fg');
 expect(tone('medium')).toContain('bg-zinc-900');
 expect(tone('low')).toContain('bg-zinc-100');
 expect(tone('critical')).not.toEqual(tone('low'));
});
