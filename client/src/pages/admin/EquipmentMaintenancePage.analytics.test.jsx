// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';
const ok = body => ({ ok: true, json: async () => body });
beforeEach(() => {
 vi.spyOn(console, 'error').mockImplementation(() => {});
 vi.stubGlobal('fetch', vi.fn(async url => {
  const u = String(url);
  if (u.includes('/alerts')) return ok({ alerts: [] });
  if (u.includes('/analytics/overview')) return ok({ total_assets: 1 });
  if (u.includes('/analytics/costs')) return ok({ costs: [] });
  if (u.includes('/analytics/reliability')) return ok({ reliability: [] });
  if (u.includes('/mileage/summary')) return ok({});
  if (u.includes('/schedules/due')) return ok({ schedules: [
   { id: 's1', equipment_name: 'Service truck', category: 'vehicle', task_name: 'Brake check', priority: 'high', next_due_at: '2026-10-01T00:00:00Z', estimated_cost: 120 },
   { id: 's2', equipment_name: 'Mower', category: 'mower', task_name: 'Blade swap', priority: 'normal', next_due_at: '2026-10-08T00:00:00Z', estimated_cost: 40 },
  ] });
  if (u.includes('/records/recent')) return ok({ records: [
   { id: 'r1', performed_at: '2026-08-05T12:00:00Z', total_cost: 150 },
   { id: 'r2', performed_at: '2026-09-02T12:00:00Z', total_cost: 62.5 },
  ] });
  return ok({ equipment: [] });
 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function openAnalytics() {
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 fireEvent.click(await screen.findByText('Analytics'));
 await screen.findByText('Brake check');
}
it('keeps urgency tones on due-schedule priorities', async () => {
 await openAnalytics();
 expect(screen.getByText('high').className).toContain('text-alert-fg');
 expect(screen.getByText('normal').className).not.toContain('text-alert-fg');
});
it('exposes the monthly cost values to assistive technology', async () => {
 await openAnalytics();
 const region = screen.getByRole('region', { name: 'Monthly maintenance costs chart' });
 expect(region).toHaveTextContent('2026-08: $150.00');
 expect(region).toHaveTextContent('2026-09: $62.50');
 expect(region.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
});
