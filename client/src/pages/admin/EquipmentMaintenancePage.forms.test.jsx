// @vitest-environment jsdom
// UI audit F0441: a failed maintenance / mileage save must stay open and say why.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceForm, MileageForm } from './EquipmentMaintenancePage';

function inputAfter(labelText) {
  return screen.getByText(labelText).parentElement.querySelector('input');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EquipmentMaintenancePage forms surface a failed save', () => {
  it('maintenance record: a 500 keeps the form open with an alert and does not call onDone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const onDone = vi.fn();
    render(<MaintenanceForm equipmentId="eq-1" schedules={[]} onDone={onDone} />);
    fireEvent.change(inputAfter('Task Name *'), { target: { value: 'Oil change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Save failed: HTTP 500/);
    expect(onDone).not.toHaveBeenCalled();
    expect(inputAfter('Task Name *')).toHaveValue('Oil change');
    expect(screen.getByRole('button', { name: 'Save Record' })).not.toBeDisabled();
  });

  it('maintenance record: a successful save calls onDone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const onDone = vi.fn();
    render(<MaintenanceForm equipmentId="eq-1" schedules={[]} onDone={onDone} />);
    fireEvent.change(inputAfter('Task Name *'), { target: { value: 'Oil change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Record' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('mileage log: a rejected POST keeps the form open with an alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    const onDone = vi.fn();
    render(<MileageForm vehicleId="v-1" currentMiles={1000} onDone={onDone} />);
    fireEvent.change(inputAfter('Odometer Start'), { target: { value: '1000' } });
    fireEvent.change(inputAfter('Odometer End'), { target: { value: '1050' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Mileage' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Save failed: Failed to fetch/);
    expect(onDone).not.toHaveBeenCalled();
  });
});
