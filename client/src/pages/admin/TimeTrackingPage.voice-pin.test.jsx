// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTab, TechVoicePinField } from './TimeTrackingPage';

// The voice line PIN field on the Team tab's technician form: digits only, 4 to 6, sent once
// to the PIN route, and never kept or shown after the request.
describe('TechVoicePinField', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'admin-1', role: 'admin' }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('accepts digits only and sends a 4 to 6 digit PIN to the technician\'s PIN route, then clears it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<TechVoicePinField technicianId="tech-1" />);
    const input = screen.getByLabelText('Voice line PIN');
    const button = screen.getByRole('button', { name: 'Set PIN' });
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: '45a' } });
    expect(input).toHaveValue('45');
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: '4512' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('PIN set.'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/admin\/timetracking\/technicians\/tech-1\/voice-pin$/);
    expect(options).toMatchObject({ method: 'PUT', body: JSON.stringify({ pin: '4512' }) });
    expect(input).toHaveValue('');
  });

  it('on the Team tab, switching Edit to another technician empties the field: a PIN typed for one never goes to another', async () => {
    const tech = (id, name) => ({ id, name, role: 'technician', active: true, employment_status: 'active' });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ technicians: [tech('tech-1', 'River Tech'), tech('tech-2', 'Lake Tech')] }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<TeamTab showToast={() => {}} />);
    await screen.findByText('River Tech');
    const edits = () => screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(edits()[0]);
    fireEvent.change(screen.getByLabelText('Voice line PIN'), { target: { value: '4512' } });
    fireEvent.click(edits()[1]);
    expect(screen.getByRole('textbox', { name: 'Name *' })).toHaveValue('Lake Tech');
    expect(screen.getByLabelText('Voice line PIN')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Set PIN' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/voice-pin'))).toBe(false);
  });

  it('shows the server\'s reason when the PIN is refused, and clears the field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'The PIN must be 4 to 6 digits' }) })));
    render(<TechVoicePinField technicianId="tech-1" />);
    fireEvent.change(screen.getByLabelText('Voice line PIN'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set PIN' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The PIN must be 4 to 6 digits'));
    expect(screen.getByLabelText('Voice line PIN')).toHaveValue('');
  });
});
