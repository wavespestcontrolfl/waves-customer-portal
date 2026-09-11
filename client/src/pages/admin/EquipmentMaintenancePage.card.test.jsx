// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';
const ok = body => ({ ok: true, json: async () => body });
const eq = { id: 'v1', name: 'Service truck', category: 'vehicle', status: 'active', condition: 'good', assigned_tech_name: 'Sam', current_miles: 1000 };
const lostEq = { id: 'm1', name: 'Missing blower', category: 'tool', status: 'lost', condition: 'unknown', assigned_tech_name: 'Unassigned' };
const detail = {
 equipment: eq,
 schedules: [{ id: 's1', task_name: 'Oil change', interval_miles: 5000, next_due_at: '2026-10-01T00:00:00Z', priority: 'high', estimated_cost: 89.5 }],
 recentRecords: [{ id: 'r1', performed_at: '2026-09-01T12:00:00Z', task_name: 'Tire rotation', maintenance_type: 'scheduled', total_cost: 60 }],
 costOfOwnership: {}
};
const mileage = { summary: { total_miles: 1000, business_miles: 900, total_fuel_cost: 10, total_irs_deduction: 5 }, logs: [{ id: 'l1', log_date: '2026-09-02', total_miles: 40, business_pct: 100, fuel_cost: 12.5, irs_deduction_amount: 26.8 }] };
let posts;
beforeEach(() => {
 posts = [];
 vi.spyOn(console, 'error').mockImplementation(() => {});
 vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST') return new Promise(resolve => posts.push(() => resolve(ok({ id: 'new' }))));
  if (u.includes('/alerts')) return ok({ alerts: [] });
  if (u.includes('/analytics/overview')) return ok({ total_assets: 1 });
  if (u.includes('/analytics/')) return ok({});
  if (/\/mileage\?/.test(u)) return ok(mileage);
  if (/\/admin\/equipment-maintenance\/v1$/.test(u)) return ok(detail);
  return ok({ equipment: [eq, lostEq] });
 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const inputAfter = label => screen.getByText(label).parentElement.querySelector('input');
async function expandCard() {
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 const opener = await screen.findByRole('button', { name: /Service truck/ });
 fireEvent.click(opener);
 await screen.findByText('Oil change');
 return opener;
}
it('names the card opener from its visible details and the expanded state', async () => {
 const opener = await expandCard();
 expect(opener).toHaveAccessibleName(/Collapse/);
 expect(opener).toHaveAccessibleName(/Service truck/);
 expect(opener).toHaveAccessibleName(/Assigned: Sam/);
 expect(opener).toHaveAccessibleName(/vehicle/); // category icon keeps the emoji's accessible text
 expect(opener).toHaveAttribute('aria-expanded', 'true');
 fireEvent.click(opener);
 expect(opener).toHaveAccessibleName(/Expand/);
 expect(opener).toHaveAttribute('aria-expanded', 'false');
});
it('keeps the alert tone on lost equipment and neutral on the rest', async () => {
 render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
 await screen.findByText('Missing blower');
 expect(screen.getByText('lost').className).toContain('text-alert-fg');
 expect(screen.getByText('active').className).not.toContain('text-alert-fg');
});
it('keeps date and amount cells on one line in the detail tables', async () => {
 await expandCard();
 expect(screen.getByText('high').className).toContain('text-alert-fg'); // priority keeps its urgency tone
 const nowrapCells = text => screen.getByText(text).closest('tr').querySelectorAll('td.whitespace-nowrap').length;
 expect(nowrapCells('Oil change')).toBe(2); // next due + estimated cost
 expect(nowrapCells('Tire rotation')).toBe(2); // performed date + total cost
 expect(nowrapCells('$26.80')).toBe(3); // log date + fuel cost + IRS deduction
});
it('opens one form at a time and keeps the card locked while a save is pending', async () => {
 const opener = await expandCard();
 fireEvent.click(screen.getByRole('button', { name: 'Record Maintenance' }));
 expect(screen.getByText('Task Name *')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: 'Log Mileage' }));
 expect(screen.queryByText('Task Name *')).not.toBeInTheDocument();
 expect(screen.getByText('Odometer End')).toBeInTheDocument();
 fireEvent.change(inputAfter('Odometer Start'), { target: { value: '1000' } });
 fireEvent.change(inputAfter('Odometer End'), { target: { value: '1050' } });
 fireEvent.click(screen.getByRole('button', { name: 'Save Mileage' }));
 await waitFor(() => expect(posts).toHaveLength(1));
 expect(opener).toBeDisabled();
 expect(screen.getByRole('button', { name: 'Record Maintenance' })).toBeDisabled();
 expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
 await act(async () => { posts[0](); });
 await waitFor(() => expect(screen.getByRole('button', { name: /Service truck/ })).not.toBeDisabled());
 expect(screen.queryByText('Odometer End')).not.toBeInTheDocument();
});
