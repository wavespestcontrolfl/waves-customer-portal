// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { etDateString } from '../../lib/timezone';
import PayGrowth from './PayGrowth';
import { request, date } from './common';

vi.mock('./common', async () => ({ ...await vi.importActual('./common'), request: vi.fn() }));
const month = etDateString(new Date()).slice(0, 7);
const people = [{ id: 'tech-a', name: 'First employee', employment_status: 'active' }, { id: 'tech-b', name: 'Second employee', employment_status: 'active' }];
function view(id = 'tech-a', amount = 1000, manage = false) {
  const outcome = { status: 'not_enough_evidence', amount_cents: null, observed: 0, unresolved: 0, immature: 0, reason: 'Not enough observations.' };
  return { person: { id, pay_rate: '22.00', job_title: 'Technician' }, month, can_manage: manage, program: { roles: [] }, level: null,
    simulation: { production: { amount_cents: amount, calculated: 1, needs_evidence: 0 }, rework: outcome, handoff: outcome, as_of_date: `${month}-01` },
    reviews: [], business: [], statements: [], entries: [], missing: [], levels: [], assessments: [] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const setup = { people, services: [], rules: [] };
const mount = manage => render(<MemoryRouter><PayGrowth manage={manage} /></MemoryRouter>);
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Pay and growth selection and write boundaries', () => {
  it('requests the technician’s own record and provides no management controls', async () => {
    request.mockResolvedValue(view());
    mount(false);
    await screen.findByRole('heading', { name: 'Monthly outcome model' });
    expect(request.mock.calls[0][0]).toBe(`/?month=${month}`);
    expect(screen.queryByLabelText('Employee')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simulation setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save simulation statement' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Service evidence' }));
    expect(screen.queryByRole('button', { name: 'Record service evidence' })).toBeNull();
    expect(screen.getByText(/not earned compensation/)).toBeTruthy();
  });

  it('requires the server’s management verdict even when the admin component is requested', async () => {
    request.mockImplementation(path => Promise.resolve(path === '/setup' ? setup : view()));
    mount(true);
    await screen.findByRole('heading', { name: 'Monthly outcome model' });
    expect(screen.queryByRole('button', { name: 'Simulation setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record origination' })).toBeNull();
  });

  it('ignores an earlier employee response that arrives after the selection changes', async () => {
    const first = deferred();
    request.mockImplementation(path => path === '/setup' ? Promise.resolve(setup)
      : path.includes('tech-a') ? first.promise : Promise.resolve(view('tech-b', 4200, true)));
    mount(true);
    const select = await screen.findByLabelText('Employee');
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('tech-a'))).toBe(true));
    fireEvent.change(select, { target: { value: 'tech-b' } });
    await screen.findByText('$42.00');
    await act(async () => first.resolve(view('tech-a', 1000, true)));
    expect(screen.queryByText('$10.00')).toBeNull();
    expect(screen.getByText('$42.00')).toBeTruthy();
  });

  it('removes the previous employee’s record when the newly selected record fails', async () => {
    request.mockImplementation(path => path === '/setup' ? Promise.resolve(setup)
      : path.includes('tech-a') ? Promise.resolve(view('tech-a', 1000, true)) : Promise.reject(new Error('Record unavailable')));
    mount(true);
    await screen.findByText('$10.00');
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-b' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Record unavailable');
    expect(screen.queryByText('$10.00')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save simulation statement' })).toBeNull();
  });

  it('keeps a statement save tied to the displayed employee and disables repeated clicks while saving', async () => {
    const write = deferred();
    request.mockImplementation(path => path === '/setup' ? Promise.resolve(setup)
      : path === '/statements' ? write.promise : Promise.resolve(view('tech-a', 1000, true)));
    mount(true);
    const save = await screen.findByRole('button', { name: 'Save simulation statement' });
    fireEvent.click(save); fireEvent.click(save);
    expect(save.disabled).toBe(true);
    expect(request.mock.calls.filter(([path]) => path === '/statements')).toEqual([
      ['/statements', { method: 'POST', body: { technician_id: 'tech-a', month } }],
    ]);
    await act(async () => write.resolve({ id: 'saved' }));
    await screen.findByText(/Simulation statement saved/);
  });

  it('keeps date-only fields intact and displays payment timestamps in Eastern time', () => {
    expect(date('2026-04-02')).toBe('2026-04-02');
    expect(date('2026-04-02T01:30:00Z')).toBe('2026-04-01');
  });
});
