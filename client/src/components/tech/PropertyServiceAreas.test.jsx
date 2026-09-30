// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PropertyServiceAreas from './PropertyServiceAreas';
import { adminFetch } from '../../utils/admin-fetch';
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
const measurements = () => ({ enabled: true, propertyId: 'property-1', customerId: 'customer-1', version: 'a'.repeat(64), areas: {
  beds: { sqft: 1200, source: 'imagery', reviewedAt: null },
  lawn: { sqft: 4200, source: 'field', reviewedAt: '2026-09-27T00:00:00Z' }, mosquito: null,
} });
const props = { serviceId: 'visit-1', serviceLine: 'tree_shrub' };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { adminFetch.mockResolvedValue(measurements()); });
describe('property area review', () => {
  it('shows imagery as unreviewed and leaves visit coverage blank', async () => {
    render(<PropertyServiceAreas {...props} onVisitAreaChange={vi.fn()} />);
    expect(await screen.findByText('Satellite estimate · Not reviewed')).toBeInTheDocument();
    expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(null);
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });
  it('saves only checked areas and preserves source; changing a value requires a new check', async () => {
    const onMeasurements = vi.fn();
    render(<PropertyServiceAreas {...props} onMeasurements={onMeasurements} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review areas' }));
    const dialog = screen.getByRole('dialog');
    const checks = within(dialog).getAllByRole('checkbox');
    expect(checks.every(input => !input.checked)).toBe(true);
    fireEvent.click(checks[0]);
    fireEvent.change(screen.getByLabelText('Ornamental beds square feet'), { target: { value: '1500' } });
    expect(checks[0]).not.toBeChecked();
    fireEvent.click(checks[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed areas' }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(adminFetch.mock.calls[1][1].body)).toEqual({ version: 'a'.repeat(64), areas: { beds: { sqft: 1500, source: 'imagery' } } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('retains edits on a stale-save refusal', async () => {
    render(<PropertyServiceAreas {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review areas' }));
    fireEvent.change(screen.getByLabelText('Ornamental beds square feet'), { target: { value: '850' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    adminFetch.mockRejectedValueOnce(Object.assign(new Error('Property areas changed. Reload before saving your correction.'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed areas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Property areas changed');
    expect(screen.getByLabelText('Ornamental beds square feet')).toHaveValue(850);
  });
  it('keeps the correction, unchecked, after an ordinary concurrent edit of the same property', async () => {
    adminFetch.mockResolvedValueOnce(measurements());
    const reloaded = measurements(); reloaded.version = 'b'.repeat(64);
    render(<PropertyServiceAreas {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review areas' }));
    fireEvent.change(screen.getByLabelText('Ornamental beds square feet'), { target: { value: '850' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    adminFetch.mockRejectedValueOnce(Object.assign(new Error('Property areas changed.'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed areas' }));
    adminFetch.mockResolvedValueOnce(reloaded);
    fireEvent.click(await screen.findByRole('button', { name: 'Load latest saved areas' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load latest saved areas' })).not.toBeInTheDocument());
    expect(screen.getByLabelText('Ornamental beds square feet')).toHaveValue(850);
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
  });
  it('discards the correction when the reload describes a different property', async () => {
    const reloaded = measurements(); reloaded.propertyId = 'property-2'; reloaded.version = 'c'.repeat(64);
    reloaded.areas.beds = { sqft: 300, source: 'field', reviewedAt: '2026-09-27' };
    render(<PropertyServiceAreas {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review areas' }));
    fireEvent.change(screen.getByLabelText('Ornamental beds square feet'), { target: { value: '850' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    adminFetch.mockRejectedValueOnce(Object.assign(new Error('The service property changed. Reload the job.'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed areas' }));
    adminFetch.mockResolvedValueOnce(reloaded);
    fireEvent.click(await screen.findByRole('button', { name: 'Load latest saved areas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('property changed');
    expect(screen.getByLabelText('Ornamental beds square feet')).toHaveValue(300);
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
  });
  it.each([
    ['the same row at a new address', { addressKey: 'new-address' }, true],
    ['an unchanged property', {}, false],
  ])('a reload describing %s clears today\'s coverage only when the property changed', async (_label, change, cleared) => {
    const first = { ...measurements(), addressKey: 'old-address' };
    adminFetch.mockResolvedValueOnce(first);
    const onVisitAreaChange = vi.fn();
    render(<PropertyServiceAreas {...props} visitArea="600" onVisitAreaChange={onVisitAreaChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review areas' }));
    fireEvent.change(screen.getByLabelText('Ornamental beds square feet'), { target: { value: '850' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    adminFetch.mockRejectedValueOnce(Object.assign(new Error('Property areas changed. Reload before saving your correction.'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed areas' }));
    adminFetch.mockResolvedValueOnce({ ...first, version: 'c'.repeat(64), ...change });
    fireEvent.click(await screen.findByRole('button', { name: 'Load latest saved areas' }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onVisitAreaChange.mock.calls.some(([area]) => area === null)).toBe(cleared));
  });
  it('treats zero as a reviewed area, and today’s coverage never issues a property write', async () => {
    const data = measurements(); data.areas.beds = { sqft: 0, source: 'field', reviewedAt: '2026-09-27' };
    adminFetch.mockResolvedValue(data);
    const onChange = vi.fn();
    render(<PropertyServiceAreas {...props} onVisitAreaChange={onChange} />);
    const input = await screen.findByLabelText('Area treated today (sq ft)');
    expect(input).toHaveValue(0);
    fireEvent.change(input, { target: { value: '100' } });
    expect(onChange).toHaveBeenCalledWith('100');
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });
  it('does not expose stale data or pending results after switching visits', async () => {
    let finish;
    adminFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PropertyServiceAreas {...props} />);
    view.rerender(<PropertyServiceAreas {...props} serviceId="visit-2" serviceLine="mosquito" />);
    await screen.findByText('Mosquito coverage');
    finish({ ...measurements(), areas: { beds: { sqft: 99999 }, lawn: null, mosquito: null } });
    await waitFor(() => expect(screen.queryByText('99,999 sq ft')).not.toBeInTheDocument());
    expect(screen.queryByText('Ornamental beds')).not.toBeInTheDocument();
  });
  it('disappears when the feature is dark', async () => {
    adminFetch.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const view = render(<PropertyServiceAreas {...props} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
  });
  it.each([
    ['a tree & shrub job with reviewed beds but no lawn', 'tree_shrub', { lawn: null }, false],
    ['a lawn job whose lawn is missing', 'lawn', { lawn: null }, true],
    ['a mosquito job (the lookup has no mosquito estimate)', 'mosquito', {}, false],
  ])('offers the paid area lookup only for the visible area: %s', async (_label, serviceLine, areas, offered) => {
    adminFetch.mockResolvedValue({ ...measurements(), areas: { ...measurements().areas, ...areas } });
    render(<PropertyServiceAreas serviceId="visit-1" serviceLine={serviceLine} />);
    await screen.findByRole('button', { name: 'Review areas' });
    expect(!!screen.queryByRole('button', { name: 'Get area estimate' })).toBe(offered);
  });
});
