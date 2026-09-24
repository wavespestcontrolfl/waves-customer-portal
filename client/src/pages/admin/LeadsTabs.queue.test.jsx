// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadsSection } from './LeadsTabs';
import EstimatesPageV2 from './EstimatesPageV2';
const { openMessages } = vi.hoisted(() => ({ openMessages: vi.fn() }));
vi.mock('../../components/admin/customer360/CustomerSmsPanel', () => ({
  useCustomerSms: () => openMessages,
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));
const lead = { id: 'lead-qa', first_name: 'QA', last_name: 'Prospect', status: 'estimate_viewed', service_interest: 'Mosquito', first_contact_at: new Date().toISOString() };
let calls;
function Location() { return <output aria-label="Current route">{useLocation().search}</output>; }
function mount(url = '/admin/pipeline', props = {}) {
  return render(<MemoryRouter initialEntries={[url]}><LeadsSection {...props} /><Location /></MemoryRouter>);
}
function mountWorkspace(url) {
  return render(<MemoryRouter initialEntries={[url]}><EstimatesPageV2 /><Location /></MemoryRouter>);
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const queueCalls = () => calls.filter(({path}) => path.includes('/admin/leads?'));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
describe('Pipeline queue navigation', () => {
  it('keeps legacy leadId alerts on the Leads tab instead of opening the estimate builder', async () => {
    mountWorkspace('/admin/pipeline?tab=leads&leadId=lead-qa&source=notification');
    expect(await screen.findByRole('button', { name: 'QA Prospect', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('lead=lead-qa'));
    expect(queueCalls().some(({ path }) => new URL(path, 'http://localhost').searchParams.get('id') === 'lead-qa')).toBe(true);
  });
  it('normalizes legacy leadId links and fetches the exact closed lead without the open filter', async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, opts) => {
      if (!String(url).includes('/admin/leads?')) return base(url, opts);
      await base(url, opts);
      return { ok: true, json: async () => ({ leads: [{ ...lead, status: 'lost' }], total: 1 }) };
    });
    mount('/admin/pipeline?leadId=lead-qa&source=notification');
    const leadButton = await screen.findByRole('button', { name: 'QA Prospect', exact: true });
    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('lead=lead-qa'));
    const route = screen.getByLabelText('Current route').textContent;
    expect(route).not.toContain('leadId=');
    expect(route).toContain('source=notification');
    const params = new URL(queueCalls().at(-1).path, 'http://localhost').searchParams;
    expect(params.get('id')).toBe('lead-qa');
    expect(params.get('status')).toBeNull();
    expect(leadButton).toHaveAttribute('aria-expanded', 'true');
  });
  it('shows loading before the first request and the empty state only after a successful response', async () => {
    const pending = deferred();
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => String(url).includes('/admin/leads?')
      ? pending.promise
      : base(url, opts));
    mount();
    expect(screen.getAllByText('Loading leads…').length).toBeGreaterThan(0);
    expect(screen.queryByText('No leads found')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching leads')).not.toBeInTheDocument();
    await act(async () => pending.resolve({ ok: true, json: async () => ({ leads: [], total: 0 }) }));
    expect(await screen.findByText('No leads found')).toBeInTheDocument();
    expect(screen.getByText('No matching leads')).toBeInTheDocument();
  });
  it('does not let a stale initial response replace newer filtered results', async () => {
    const pending = [];
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => {
      if (!String(url).includes('/admin/leads?')) return base(url, opts);
      calls.push({ path: String(url), options: opts });
      const request = deferred();
      pending.push(request);
      return request.promise;
    });
    mount();
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search leads' }), { target: { value: 'newest' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1].resolve({ ok: true, json: async () => ({ leads: [{ ...lead, first_name: 'Newest' }], total: 1 }) }));
    expect(await screen.findByRole('button', { name: 'Newest Prospect' })).toBeInTheDocument();
    await act(async () => pending[0].resolve({ ok: true, json: async () => ({ leads: [{ ...lead, first_name: 'Stale' }], total: 1 }) }));
    expect(screen.getByRole('button', { name: 'Newest Prospect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stale Prospect' })).not.toBeInTheDocument();
  });
  it('shows a failed load separately from an empty pipeline', async () => {
    const base = fetch.getMockImplementation();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockImplementation((url, opts) => String(url).includes('/admin/leads?')
      ? Promise.reject(new Error('Synthetic pipeline failure'))
      : base(url, opts));
    mount();
    expect(await screen.findByText(/Synthetic pipeline failure/)).toBeInTheDocument();
    expect(screen.getByText('Lead results unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No leads found')).not.toBeInTheDocument();
  });
  it('collects a loss reason before the stage selector posts to the lost endpoint', async () => {
    mount();
    const stage = await screen.findByRole('combobox', { name: 'Stage for QA Prospect' });
    fireEvent.change(stage, { target: { value: 'lost' } });
    const dialog = screen.getByRole('dialog', { name: 'Mark lead lost' });
    const submit = screen.getByRole('button', { name: 'Mark Lost' });
    expect(calls.some(({ path, options }) => path.endsWith('/lead-qa') && options?.method === 'PUT')).toBe(false);
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'no_response' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some(({ path, options }) => path.endsWith('/lead-qa/lost') && options?.method === 'POST')).toBe(true));
    const request = calls.find(({ path, options }) => path.endsWith('/lead-qa/lost') && options?.method === 'POST');
    expect(JSON.parse(request.options.body)).toMatchObject({ leadId: 'lead-qa', reason: 'no_response' });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
  it('routes a board drop into Lost through the same loss form', async () => {
    mount();
    await screen.findByRole('button', { name: 'QA Prospect' });
    fireEvent.click(screen.getByRole('button', { name: 'Board', exact: true }));
    const card = screen.getByText('QA Prospect', { exact: true }).closest('[draggable="true"]');
    const lostHeading = screen.getAllByText('lost', { exact: true }).find((element) => element.tagName === 'SPAN');
    const lostColumn = lostHeading.parentElement.parentElement;
    const values = new Map();
    const dataTransfer = {
      setData: (type, value) => values.set(type, value),
      getData: (type) => values.get(type) || '',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(lostColumn, { dataTransfer });
    expect(screen.getByRole('dialog', { name: 'Mark lead lost' })).toBeInTheDocument();
    expect(calls.some(({ path, options }) => path.endsWith('/lead-qa') && options?.method === 'PUT')).toBe(false);
  });
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
  it('explains automated contact evidence only when lead review is enabled', async () => {
    const base = fetch.getMockImplementation();
    const activities = [
      { id: 'activity-live', activity_type: 'status_change', description: 'Status: new → contacted', performed_by: 'AI Call Processor', created_at: '2040-09-05T17:00:00Z', metadata: JSON.stringify({ evidenceType: 'live_conversation', evidenceId: 'call-evidence-1234567890' }) },
      { id: 'activity-booked', activity_type: 'status_change', description: 'Status: new → contacted', performed_by: 'Fixture operator', created_at: '2040-09-05T18:00:00Z', metadata: { evidenceType: 'assessment_booked', evidenceId: 'booking_fixture_2' } },
      { id: 'activity-completed', activity_type: 'status_change', description: 'Status: new → contacted', performed_by: 'system', created_at: '2040-09-05T19:00:00Z', metadata: JSON.stringify({ evidenceType: 'assessment_completed', evidenceId: '<unsafe>' }) },
      { id: 'activity-unsupported', activity_type: 'status_change', description: 'Unsupported automation remains visible', performed_by: 'system', created_at: '2040-09-05T20:00:00Z', metadata: JSON.stringify({ evidenceType: '__proto__', evidenceId: 'unsupported-fixture' }) },
    ];
    fetch.mockImplementation(async (url, opts) => String(url).endsWith('/admin/leads/lead-qa')
      ? { ok: true, json: async () => ({ lead, activities, calls: [] }) }
      : base(url, opts));
    mount('/admin/pipeline?leadReview=1');
    fireEvent.click(await screen.findByRole('button', { name: 'QA Prospect' }));
    expect(await screen.findByText('Contacted after a live conversation')).toBeInTheDocument();
    expect(screen.getByText('Contacted after an assessment was booked')).toBeInTheDocument();
    expect(screen.getByText('Contacted after an assessment was completed')).toBeInTheDocument();
    expect(screen.getByText(/Evidence reference call-evi.*7890/)).toBeInTheDocument();
    expect(screen.queryByText(/unsafe/)).not.toBeInTheDocument();
    expect(screen.getByText(/AI Call Processor/)).toBeInTheDocument();
    expect(screen.getByText('Unsupported automation remains visible')).toBeInTheDocument();
  });
  it('keeps automated contact evidence hidden by default', async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, opts) => String(url).endsWith('/admin/leads/lead-qa')
      ? { ok: true, json: async () => ({ lead, activities: [{ id: 'activity-live', activity_type: 'status_change', description: 'Status: new → contacted', performed_by: 'AI Call Processor', created_at: '2040-09-05T17:00:00Z', metadata: { evidenceType: 'live_conversation', evidenceId: 'call-fixture' } }], calls: [] }) }
      : base(url, opts));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'QA Prospect' }));
    expect(await screen.findByText('Status: new → contacted')).toBeInTheDocument();
    expect(screen.queryByText('Contacted after a live conversation')).not.toBeInTheDocument();
    expect(screen.queryByText(/Evidence reference/)).not.toBeInTheDocument();
  });
  it('shows the effective callback deadline on the lead', async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, opts) => String(url).includes('/commitments/open')
      ? { ok: true, json: async () => ({ commitments: [{ id: 'callback-1', party: 'waves',
        description: 'Synthetic callback', due_at: null, effective_due_at: '2040-09-05T17:00:00Z',
        call_started_at: '2040-09-05T13:00:00Z' }], enabled: true }) }
      : base(url, opts));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'QA Prospect' }));
    expect(await screen.findByText(/Due Sep 5.*1:00/)).toBeInTheDocument();
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
    mount('/admin/pipeline?leadReview=1&leadStatus=lost&leadPage=2&leadSearch=old', { newLeadRequest: 1 });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9415550100' } });
    expect(await screen.findByText(/Possible existing leads with this contact/)).toBeInTheDocument();
    expect(calls.some(({ options }) => options?.method === 'POST')).toBe(false);
    const match = [...screen.getByRole('dialog').querySelectorAll('button')].find((button) => button.textContent.includes('QA Prospect'));
    expect(match).toBeTruthy();
    fireEvent.click(match);
    await waitFor(() => expect(queueCalls().at(-1).path).toContain('id=lead-qa'));
    expect(screen.getByLabelText('Current route')).toHaveTextContent('lead=lead-qa');
    expect(screen.getByLabelText('Current route')).toHaveTextContent('leadReview=1');
    expect(screen.getByLabelText('Current route')).not.toHaveTextContent('leadStatus=');
    expect(screen.getByLabelText('Current route')).not.toHaveTextContent('leadPage=');
    expect(screen.getByLabelText('Current route')).not.toHaveTextContent('leadSearch=');
    expect(screen.getByRole('button', { name: 'QA Prospect', exact: true })).toHaveAttribute('aria-expanded', 'true');
  });

});
