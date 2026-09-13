// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 vi.spyOn(console, 'error').mockImplementation(() => {});
 vi.stubGlobal('fetch', vi.fn(async url => {
  const u = String(url);
  if (u.includes('/alerts')) return ok({ alerts });
  if (u.includes('/analytics/overview')) return ok({});
  if (u.includes('/analytics/')) return ok({});
  return ok({ equipment: [] });
 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
it('keeps filter selects accessible without adding visible label copy', async () => {
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 await screen.findByText(/4 Active Alerts/);
 expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
 expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
 expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeInTheDocument();
 expect(screen.queryByText('Sort by')).not.toBeInTheDocument();
 expect(screen.queryByText('Category', { selector: 'label' })).not.toBeInTheDocument();
 expect(screen.getByText('All Categories')).toBeInTheDocument();
});
it('keeps loaded fleet data visible when a post-save refresh fails', async () => {
 const eq = { id: 'e1', name: 'Zero-turn mower', category: 'mower', status: 'active' };
 let failReads = false;
 vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST') return ok({ id: 'r1' });
  if (failReads && u.includes('/admin/equipment-maintenance')) return { ok: false, status: 503, json: async () => ({}) };
  if (u.includes('/alerts')) return ok({ alerts });
  if (u.includes('/analytics/overview')) return ok({ total_assets: 1 });
  if (u.includes('/analytics/')) return ok({});
  if (/\/admin\/equipment-maintenance\/e1$/.test(u)) return ok({ equipment: eq, schedules: [], recentRecords: [], costOfOwnership: {} });
  return ok({ equipment: [eq] });
 }));
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 fireEvent.click(await screen.findByText(eq.name));
 fireEvent.click(await screen.findByRole('button', { name: 'Record Maintenance' }));
 const input = screen.getByText('Task Name *').parentElement.querySelector('input');
 fireEvent.change(input, { target: { value: 'Blade sharpening' } });
 failReads = true;
 fireEvent.click(screen.getByRole('button', { name: 'Save Record' }));
 const fleetNotice = (await screen.findByText(/Could not refresh fleet/)).closest('[role="alert"]');
 expect(screen.getByText(eq.name)).toBeInTheDocument();
 expect(screen.getByText(/4 Active Alerts/)).toBeInTheDocument();
 failReads = false;
 // The expanded card's own detail retry also renders 'Try again'; scope to the fleet notice.
 fireEvent.click(within(fleetNotice).getByRole('button', { name: 'Try again' }));
 await waitFor(() => expect(screen.queryByText(/Could not refresh fleet/)).not.toBeInTheDocument());
 expect(screen.getByText(eq.name)).toBeInTheDocument();
});
