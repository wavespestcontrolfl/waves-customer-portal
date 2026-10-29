// @vitest-environment jsdom
// Commission "Sold by" (GATE_COMMISSION_SOLD_BY, owner 2026-10-29, D5 part 3b-1): the flag modal shows
// the Neighbor mode and sends the new fields only while the gate is on. With it off the modal posts
// exactly the body it always posted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockGateOn = false;
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: (key) => (key === 'commission_sold_by' ? mockGateOn : false),
}));
vi.mock('./fieldPortal', () => ({ useFieldPortalClass: () => '' }));
vi.mock('../../hooks/useModalFocus', () => ({ default: () => ({ current: null }) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'token' }));

import FieldLeadModal from './FieldLeadModal';

const SERVICE = { id: 'visit-1', customer_id: 'customer-1', customerName: 'Sample Customer', address: '1 Sample St' };
let posted;

beforeEach(() => {
  posted = null;
  vi.stubGlobal('fetch', vi.fn((_url, options) => {
    posted = JSON.parse(options.body);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  }));
});
afterEach(() => {
  cleanup();
  mockGateOn = false;
  vi.unstubAllGlobals();
});

const pickService = (type) => fireEvent.change(screen.getByRole('combobox'), { target: { value: type } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Submit Lead' }));
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('FieldLeadModal with the gate off', () => {
  it('shows no Neighbor mode and posts the same body as before', async () => {
    render(<FieldLeadModal service={SERVICE} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Neighbor' })).not.toBeInTheDocument();
    pickService('Lawn');
    submit();
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({ customerId: 'customer-1', leadServiceType: 'Lawn', notes: '', urgency: 'normal' });
  });
});

describe('FieldLeadModal with the gate on', () => {
  it('sends the visit it was opened from with a customer flag', async () => {
    mockGateOn = true;
    render(<FieldLeadModal service={SERVICE} onClose={() => {}} />);
    pickService('Pest');
    submit();
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({
      customerId: 'customer-1', leadServiceType: 'Pest', notes: '', urgency: 'normal', scheduledServiceId: 'visit-1',
    });
  });

  it('posts the Neighbor details with no customer, and asks for the required ones first', async () => {
    mockGateOn = true;
    render(<FieldLeadModal service={SERVICE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbor' }));
    pickService('Lawn');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('First name, phone, address and ZIP are required');
    expect(posted).toBeNull();
    type('First name', 'Neighbor');
    type('Last name', 'Sample');
    type('Phone', '(941) 555-0142');
    type('Address', '12 Sample Way');
    type('City', 'Bradenton');
    type('ZIP', '34202');
    submit();
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({
      leadServiceType: 'Lawn', notes: '', urgency: 'normal',
      prospect: { firstName: 'Neighbor', lastName: 'Sample', phone: '(941) 555-0142', address: '12 Sample Way', city: 'Bradenton', zip: '34202' },
    });
    expect(posted.customerId).toBeUndefined();
  });
});
