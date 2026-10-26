// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleAccessLine, ScheduleAccessSection } from './ScheduleAccess';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body), headers: { get: () => null } });

const SERVICE = {
  id: 'visit-1',
  scheduleAccessEnabled: true,
  neighborhoodGateActions: true,
  propertyAlerts: [
    { type: 'gate', text: 'Gate: #4821 (neighborhood)', neighborhoodEntryId: 'entry-1', neighborhoodEntryCode: '#4821', reportedWrong: false },
    { type: 'gate', text: 'Lockbox: 2468' },
    { type: 'pet', text: '1 dog' },
  ],
};

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScheduleAccessLine', () => {
  it('shows every code of the stop on one line, tagged, and nothing else from the alerts', () => {
    render(<ScheduleAccessLine service={SERVICE} />);
    const line = screen.getByTestId('schedule-access-line');
    expect(line).toHaveTextContent('Gate#4821neighborhood·Lockbox2468');
    expect(line).not.toHaveTextContent('dog');
  });

  it('says "confirm on site" for a neighborhood code nobody has confirmed', () => {
    render(<ScheduleAccessLine service={{ ...SERVICE, propertyAlerts: [{ type: 'gate', text: 'Gate: #2424 (neighborhood, confirm on site)' }] }} />);
    expect(screen.getByTestId('schedule-access-line')).toHaveTextContent('Gate#2424confirm on site');
  });

  it('draws nothing while the gate is off or the stop has no code', () => {
    const { container, rerender } = render(<ScheduleAccessLine service={{ ...SERVICE, scheduleAccessEnabled: undefined }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ScheduleAccessLine service={{ ...SERVICE, propertyAlerts: [{ type: 'pet', text: '1 dog' }] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ScheduleAccessSection (Details)', () => {
  it('lists the lines and the accepted codes the lines do not show', async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [
      { id: 'c1', kind: 'door', code: '1357', instructions: null, life: 'standing' },
      { id: 'c2', kind: 'lockbox', code: '2468', instructions: null, life: 'standing', profileBacked: true },
      { id: 'c3', kind: 'pass', code: null, instructions: 'Show https://pass.example.invalid/x at the gate', life: 'standing' },
    ] }));
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions />);
    expect(fetch).toHaveBeenCalledWith('/api/admin/access-codes/visits/visit-1', expect.anything());
    const section = await screen.findByText('Door or lock');
    expect(section).toBeInTheDocument();
    expect(screen.getByText('1357')).toBeInTheDocument();
    // The lockbox line already shows 2468: the accepted row is not repeated.
    expect(screen.getAllByText('2468')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open visitor pass' })).toHaveAttribute('href', 'https://pass.example.invalid/x');
    expect(screen.getByText('Gate · neighborhood')).toBeInTheDocument();
  });

  it('shows the lines alone when the access codes section is off (404)', async () => {
    fetch.mockResolvedValueOnce(json(404, { error: 'Not found' }));
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('#4821')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when the accepted codes fail to load, and tries again', async () => {
    fetch.mockResolvedValueOnce(json(500, { error: 'Request failed' }));
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Could not load this stop's accepted codes.");
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a wrong code only after the in-page confirm, then shows the fresh row', async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [] }));
    const fresh = { ...SERVICE, propertyAlerts: [{ type: 'gate', text: 'Gate: #4821 (neighborhood)', neighborhoodEntryId: 'entry-1', neighborhoodEntryCode: '#4821', reportedWrong: true }] };
    const onChanged = vi.fn().mockResolvedValue(fresh);
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions onChanged={onChanged} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Wrong code' }));
    expect(screen.getByRole('group', { name: 'Confirm wrong code' })).toHaveTextContent('Report #4821 as not working? The office will check it.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce(json(200, { ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/admin/neighborhood-access/visits/visit-1/entries/entry-1/wrong',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '#4821' }) }),
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Reported. The office will check that code.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reported wrong')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrong code' })).not.toBeInTheDocument();
  });

  it("adds a gate code to the stop's neighborhood", async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [] }));
    const onChanged = vi.fn().mockResolvedValue(null);
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions onChanged={onChanged} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Add gate code' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Neighborhood gate code'), { target: { value: ' #7777 ' } });
    fetch.mockResolvedValueOnce(json(201, { ok: true }));
    fireEvent.click(save);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/admin/neighborhood-access/visits/visit-1/entries',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '#7777' }) }),
    ));
    expect(await screen.findByRole('status')).toHaveTextContent("Saved to this neighborhood's gate codes.");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Neighborhood gate code')).not.toBeInTheDocument();
  });

  it("shows the server's refusal and refreshes when the code changed under the screen", async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [] }));
    const onChanged = vi.fn().mockResolvedValue(null);
    render(<ScheduleAccessSection service={SERVICE} variant="sheet" actions onChanged={onChanged} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fetch.mockResolvedValueOnce(json(409, { error: 'That code was changed. Check your route for the new one.', code: 'entry_changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code was changed. Check your route for the new one.');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no actions where the stop cannot take them', async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [] }));
    const plain = { ...SERVICE, neighborhoodGateActions: undefined, propertyAlerts: [{ type: 'gate', text: 'Gate: 1234' }] };
    render(<ScheduleAccessSection service={plain} variant="sheet" actions />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrong code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add gate code' })).not.toBeInTheDocument();
  });

  it('draws nothing and reads nothing while the gate is off', () => {
    const { container } = render(<ScheduleAccessSection service={{ ...SERVICE, scheduleAccessEnabled: false }} variant="sheet" actions />);
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ScheduleAccessSection (desktop panel)', () => {
  it('shows the codes read only', async () => {
    fetch.mockResolvedValueOnce(json(200, { accessCodes: [{ id: 'c1', kind: 'call_box', code: '102', instructions: null, life: 'standing' }] }));
    render(<ScheduleAccessSection service={SERVICE} variant="panel" />);
    expect(screen.getByText('Access')).toBeInTheDocument();
    expect(screen.getByText('#4821')).toBeInTheDocument();
    expect(await screen.findByText('Call box')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
