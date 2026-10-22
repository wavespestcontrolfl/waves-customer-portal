// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../AddressAutocomplete', () => ({
  default: ({ value, onSelect }) => (
    <>
      <input aria-label="quick-add address" value={value} readOnly />
      {/* What a blur re-geocode of a unit address hands back. */}
      <button type="button" onClick={() => onSelect({ line1: '200 Example Way', line2: 'Apt 4', city: 'Bradenton', state: 'FL', zip: '34200' })}>regeocode</button>
    </>
  ),
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stubFetch = () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const renderModal = (props = {}) => render(
  <MemoryRouter>
    <CreateAppointmentModal defaultDate="2035-01-02" defaultWindowStart="13:00" onClose={vi.fn()} onCreated={vi.fn()} {...props} />
  </MemoryRouter>,
);

describe('CreateAppointmentModal defaultQuickAddAddress', () => {
  it('opens New customer with the address filled and creates nothing', () => {
    const fetcher = stubFetch();
    renderModal({ defaultQuickAddAddress: { address: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200' } });
    expect(screen.getByLabelText('quick-add address').value).toBe('100 Example Way');
    expect(screen.getByDisplayValue('Bradenton')).toBeTruthy();
    expect(screen.getByDisplayValue('34200')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add customer' })).toBeTruthy();
    const writes = fetcher.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');
    expect(writes).toEqual([]);
  });

  it('a re-geocode of the address keeps its apartment unit (Codex #6411 r1)', () => {
    stubFetch();
    renderModal({ defaultQuickAddAddress: { address: '200 Example Way Apt 4', city: 'Bradenton', state: 'FL', zip: '34200' } });
    fireEvent.click(screen.getByText('regeocode'));
    expect(screen.getByLabelText('quick-add address').value).toBe('200 Example Way Apt 4');
  });

  it('leaves New customer closed without it', () => {
    stubFetch();
    renderModal();
    expect(screen.queryByRole('button', { name: 'Add customer' })).toBeNull();
  });
});
