// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadsSection } from './LeadsTabs';
const { openMessages } = vi.hoisted(() => ({ openMessages: vi.fn() }));
vi.mock('../../components/admin/customer360/CustomerSmsPanel', () => ({ useCustomerSms: () => openMessages }));
const lead = { id: 'lead-qa', first_name: 'QA', last_name: 'Prospect', status: 'estimate_viewed', service_interest: 'Mosquito', first_contact_at: new Date().toISOString() };
let calls;
function Location() { return <output aria-label="Current route">{useLocation().search}</output>; }
function mount(url = '/admin/pipeline', props = {}) {
  return render(<MemoryRouter initialEntries={[url]}><LeadsSection {...props} /><Location /></MemoryRouter>);
}
beforeEach(() => {
  openMessages.mockClear();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = String(url); calls.push({ path, options });
    const body = path.includes('/admin/leads?') ? { leads: [lead], total: 63 } : path.endsWith('/sources') ? { sources: [] } : {};
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const queueCalls = () => calls.filter(({path}) => path.includes('/admin/leads?'));
describe('Pipeline queue navigation', () => {
  it('refreshes activity after messaging without collapsing the active lead', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'QA Prospect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Message', exact: true }));
    expect(openMessages.mock.calls[0][1].leadId).toBe("lead-qa");
    const before = calls.filter(({ path }) => path === '/api/admin/leads/lead-qa').length;
    await act(async () => openMessages.mock.calls[0][1].onSent());
    await waitFor(() => expect(calls.filter(({ path }) => path === '/api/admin/leads/lead-qa').length).toBeGreaterThan(before));
    expect(screen.getByRole('button', { name: 'QA Prospect', exact: true })).toHaveAttribute('aria-expanded', 'true');
  });
  it('retains source and date scope on its first request', async () => {
    mount('/admin/pipeline?source_name=Synthetic&from=2020-01-01&to=2020-02-01&period_label=Test');
    await screen.findByRole('button', { name: 'QA Prospect' });
    const params = new URL(queueCalls()[0].path, 'http://localhost').searchParams;
    expect(params.get('source_name')).toBe('Synthetic');
    expect(params.get('start_date')).toBe('2020-01-01');
    expect(params.get('end_date')).toBe('2020-02-01');
    expect(params.get('status')).toBeNull();
    expect(screen.getByLabelText('Current route')).toHaveTextContent('source_name=Synthetic');
  });
  it('filters both views consistently and paginates the board including viewed leads', async () => {
    mount('/admin/pipeline?leadStatus=estimate_viewed&leadSort=name');
    await screen.findByRole('button', { name: 'QA Prospect' });
    fireEvent.click(screen.getByRole('button', { name: 'Board', exact: true }));
    expect(screen.getByRole('region', { name: 'Lead board' })).toHaveTextContent('QA Prospect');
    expect(screen.getByText(/column counts show this page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
    await waitFor(() => expect(queueCalls().some(({path}) => new URL(path, 'http://localhost').searchParams.get('page') === '2')).toBe(true));
    const params = new URL(queueCalls().at(-1).path, 'http://localhost').searchParams;
    expect(params.get('status')).toBe('estimate_viewed'); expect(params.get('sort')).toBe('name'); expect(params.get('order')).toBe('asc');
  });
  it('debounces search without loading analytics', async () => {
    mount(); await screen.findByRole('button', { name: 'QA Prospect' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search leads' }), { target: { value: 'QA mosquito' } });
    await waitFor(() => expect(queueCalls().at(-1).path).toContain('search=QA+mosquito'));
    expect(calls.some(({path}) => path.includes('/analytics/'))).toBe(false);
    expect(screen.getByLabelText('Current route')).toHaveTextContent('leadSearch=QA+mosquito');
  });
  it('creates a lead without estimator or property requirements', () => {
    mount('/admin/pipeline', { newLeadRequest: 1 });
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toBeInTheDocument(); expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Property and intake details (optional)').closest('details')).not.toHaveAttribute('open');
  });
  it('shows contact-match candidates without creating or merging a lead', async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, opts) => String(url).includes('/contact-matches?')
      ? { ok: true, json: async () => ({ matches: [lead], total: 1 }) }
      : base(url, opts));
    mount('/admin/pipeline', { newLeadRequest: 1 });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9415550100' } });
    expect(await screen.findByText(/Possible existing leads with this contact/)).toBeInTheDocument();
    expect(calls.some(({ options }) => options?.method === 'POST')).toBe(false);
    const match = [...screen.getByRole('dialog').querySelectorAll('button')].find((button) => button.textContent.includes('QA Prospect'));
    expect(match).toBeTruthy();
    fireEvent.click(match);
    await waitFor(() => expect(queueCalls().at(-1).path).toContain('id=lead-qa'));
    expect(screen.getByLabelText('Current route')).toHaveTextContent('lead=lead-qa');
    expect(screen.getByRole('button', { name: 'QA Prospect', exact: true })).toHaveAttribute('aria-expanded', 'true');
  });

});
