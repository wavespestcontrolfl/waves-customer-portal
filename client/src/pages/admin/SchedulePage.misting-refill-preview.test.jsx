// @vitest-environment jsdom
// The edit modal's server money preview prices a misting refill for the house the save will move the visit to (misting PR 2c):
// the preview request must carry the re-picked Service address exactly as the save does, and a new pick must ask again.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditServiceModal } from './SchedulePage';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
vi.mock('../../components/schedule/useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: undefined }),
}));

const service = { id: 'fixture-visit', customerId: 'fixture-account', customerName: 'Fixture account', serviceType: 'Mosquito Misting Service Plan', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:00', status: 'confirmed' };
const PROPERTIES = [
  { id: 'prop-a', label: 'House A', address_line1: '1 Example Way', city: 'Venice', state: 'FL', zip: '34285' },
  { id: 'prop-b', label: 'House B', address_line1: '2 Example Way', city: 'Venice', state: 'FL', zip: '34285' },
];

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/properties?context=appointment_address')
      ? { properties: PROPERTIES, canChangeAppointmentAddress: true }
      : (String(url).endsWith('/admin/discounts') ? [] : {})),
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

const previews = () => fetch.mock.calls.filter(([url]) => String(url).includes('/update-details/preview')).map(([, options]) => JSON.parse(options.body));

it('sends the re-picked Service address on the money preview, asks again on a new pick, and sends none when the address is kept', async () => {
  render(<EditServiceModal service={service} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  const picker = await screen.findByLabelText('Service address');
  await waitFor(() => expect(previews().length).toBeGreaterThan(0), { timeout: 3000 });
  expect(previews().at(-1)).not.toHaveProperty('propertyId');

  fireEvent.change(picker, { target: { value: 'prop-b' } });
  await waitFor(() => expect(previews().at(-1)).toMatchObject({ propertyId: 'prop-b' }), { timeout: 3000 });

  fireEvent.change(picker, { target: { value: 'prop-a' } });
  await waitFor(() => expect(previews().at(-1)).toMatchObject({ propertyId: 'prop-a' }), { timeout: 3000 });

  fireEvent.change(picker, { target: { value: '' } });
  await waitFor(() => expect(previews().at(-1)).not.toHaveProperty('propertyId'), { timeout: 3000 });
});
