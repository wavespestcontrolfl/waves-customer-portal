// @vitest-environment jsdom
// Pins the Account-menu profile edit (GATE_CUSTOMER_PROFILE_EDIT): hidden while the gate is off, the form opens
// pre-filled, a bad email or empty first name never reaches the server, a save sends the three fields and then
// re-reads /auth/me, and a server refusal shows its message and keeps the form open.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({ default: { updateCustomerProfile: vi.fn() } }));

import api from '../../utils/api';
import ProfileEditCard from './ProfileEditCard';

const customer = { firstName: 'Pat', lastName: 'Sample', email: 'pat.sample@example.test', phone: '9415550100' };
const renderCard = (props = {}) => render(<ProfileEditCard customer={customer} enabled refreshCustomer={vi.fn().mockResolvedValue(undefined)} {...props} />);

beforeEach(() => { api.updateCustomerProfile.mockReset(); });
afterEach(cleanup);

describe('ProfileEditCard', () => {
  it('renders nothing while the gate is off', () => {
    const { container } = renderCard({ enabled: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a form pre-filled with the current name and email, with no phone field', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    expect(screen.getByLabelText('First name')).toHaveValue('Pat');
    expect(screen.getByLabelText('Last name')).toHaveValue('Sample');
    expect(screen.getByLabelText('Email')).toHaveValue('pat.sample@example.test');
    expect(screen.queryByLabelText(/phone/i)).toBeNull();
  });

  it('blocks a bad email and an empty first name before any request', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('valid email');
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('first name');
    expect(api.updateCustomerProfile).not.toHaveBeenCalled();
  });

  it('saves trimmed values, re-reads /auth/me and closes the form', async () => {
    api.updateCustomerProfile.mockResolvedValue({ profile: {} });
    const refreshCustomer = vi.fn().mockResolvedValue(undefined);
    renderCard({ refreshCustomer });
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' new.address@example.test ' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(refreshCustomer).toHaveBeenCalledTimes(1));
    expect(api.updateCustomerProfile).toHaveBeenCalledWith({ firstName: 'Pat', lastName: 'Sample', email: 'new.address@example.test' });
    expect(screen.queryByTestId('profile-edit-form')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('shows the server message and keeps the form open when the save fails', async () => {
    api.updateCustomerProfile.mockRejectedValue(new Error('Too many profile changes. Please try again later.'));
    const refreshCustomer = vi.fn();
    renderCard({ refreshCustomer });
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many profile changes'));
    expect(screen.getByTestId('profile-edit-form')).toBeInTheDocument();
    expect(refreshCustomer).not.toHaveBeenCalled();
  });
});
