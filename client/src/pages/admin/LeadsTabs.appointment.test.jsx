// @vitest-environment jsdom
// The lead's inline Add Appointment form: past days are not offered, technicians show by
// name, and the note under the form matches what the server does for a Waves Assessment
// (books it without winning the lead). Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadsSection } from './LeadsTabs';
import { etDateString } from '../../lib/timezone';
vi.mock('../../components/admin/customer360/CustomerSmsPanel', () => ({
  useCustomerSms: () => vi.fn(),
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));

const lead = {
  id: 'lead-qa', first_name: 'QA', last_name: 'Prospect', status: 'new',
  service_interest: 'Pest Control', source_name: 'Synthetic source', first_contact_at: new Date().toISOString(),
};
const services = [
  { id: 'svc-pest', name: 'General Pest Control', service_key: 'pest_general' },
  { id: 'svc-assess', name: 'Waves Assessment', service_key: 'lawn_inspection' },
];
// /admin/dispatch/technicians answers id, name, role (technicians has no first_name / last_name).
const technicians = [{ id: 'tech-qa', name: 'Sam Field', role: 'technician' }];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const body = path.includes('/admin/leads?') ? { leads: [lead], total: 1 }
      : path.includes('/admin/services?') ? { services }
        : path.includes('/admin/dispatch/technicians') ? { technicians }
          : path.endsWith('/sources') ? { sources: [] } : {};
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openAppointmentForm() {
  render(<MemoryRouter initialEntries={['/admin/pipeline']}><LeadsSection /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'QA Prospect', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add Appt' }));
  return screen.getByText('Add Appointment').parentElement;
}

describe('lead Add Appointment form', () => {
  it('offers today (ET) or later only', async () => {
    const form = await openAppointmentForm();
    expect(form.querySelector('input[type="date"]')).toHaveAttribute('min', etDateString());
  });

  it('lists technicians by name', async () => {
    await openAppointmentForm();
    expect(await screen.findByRole('option', { name: 'Sam Field' })).toBeInTheDocument();
  });

  it('says a paid service wins the lead and a Waves Assessment does not', async () => {
    await openAppointmentForm();
    const serviceSelect = (await screen.findByRole('option', { name: 'Waves Assessment' })).closest('select');
    fireEvent.change(serviceSelect, { target: { value: 'svc-pest' } });
    expect(screen.getByText(/and marks the lead won\.$/)).toBeInTheDocument();
    fireEvent.change(serviceSelect, { target: { value: 'svc-assess' } });
    expect(screen.getByText(/books the assessment\. It does not mark the lead won/)).toBeInTheDocument();
    expect(screen.queryByText(/and marks the lead won\.$/)).not.toBeInTheDocument();
  });
});
