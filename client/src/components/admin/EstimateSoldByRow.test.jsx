// @vitest-environment jsdom
// "Sold by" row on the admin estimate card (GATE_COMMISSION_SOLD_BY, owner 2026-10-29, D5 part 3b-1):
// nothing without estimate.soldBy, and the three states with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockAdminFetch = vi.fn();
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: (...args) => mockAdminFetch(...args) }));

import EstimateSoldByRow, { soldByDetail } from './EstimateSoldByRow';

const TECHS = [{ id: 't1', name: 'Sample Alpha' }, { id: 't2', name: 'Sample Bravo' }];
beforeEach(() => {
  mockAdminFetch.mockReset();
  mockAdminFetch.mockImplementation((path) => (path.includes('/sold-by/options')
    ? Promise.resolve({ technicians: TECHS })
    : Promise.resolve({ success: true })));
});
afterEach(cleanup);

const estimate = (soldBy, patch = {}) => ({ id: 'est-1', acceptedAt: null, soldBy, ...patch });
const BLANK = { technicianId: null, name: null, source: null, leadId: null, gpsDistanceM: null, flaggedAt: null };

describe('EstimateSoldByRow', () => {
  it('renders nothing, and reads nothing, without soldBy (gate off)', () => {
    const { container } = render(<EstimateSoldByRow estimate={{ id: 'est-1' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockAdminFetch).not.toHaveBeenCalled();
  });

  it('shows a flag seller with the truck distance and date', async () => {
    render(<EstimateSoldByRow estimate={estimate({
      technicianId: 't1', name: 'Sample Alpha', source: 'flag', leadId: 'l1', gpsDistanceM: 40, flaggedAt: '2026-10-20T15:00:00Z',
    })}
    />);
    expect(screen.getByText('Sample Alpha', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText("from Sample Alpha's flag, truck 40 m away, Oct 20")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sample Bravo' })).toBeInTheDocument());
  });

  it('shows an office choice', () => {
    render(<EstimateSoldByRow estimate={estimate({ ...BLANK, technicianId: 't2', name: 'Sample Bravo', source: 'office' })} />);
    expect(screen.getByText('set by the office')).toBeInTheDocument();
  });

  it('shows No one when unset or cleared, and saves a choice', async () => {
    const onChanged = vi.fn();
    render(<EstimateSoldByRow estimate={estimate(BLANK)} onChanged={onChanged} />);
    expect(screen.getByText('No one', { selector: 'span' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sample Alpha' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Sold by'), { target: { value: 't1' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockAdminFetch).toHaveBeenCalledWith('/admin/estimates/est-1/sold-by', {
      method: 'PUT', body: JSON.stringify({ technicianId: 't1' }),
    });
  });

  it('disables the choice once the customer accepted', () => {
    render(<EstimateSoldByRow estimate={estimate(BLANK, { acceptedAt: '2026-10-25T12:00:00Z' })} />);
    expect(screen.getByLabelText('Sold by')).toBeDisabled();
  });

  it('words a flag with no logged distance', () => {
    expect(soldByDetail({ source: 'flag', technicianId: 't1', name: 'Sample Alpha', gpsDistanceM: null, flaggedAt: null }))
      .toBe("from Sample Alpha's flag, truck GPS checked");
  });
});
