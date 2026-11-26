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

const customer = { profileEdit: true, firstName: 'Pat', lastName: 'Sample', email: 'pat.sample@example.test', phone: '9415550100' };
const renderCard = (props = {}) => render(<ProfileEditCard customer={customer} refreshCustomer={vi.fn().mockResolvedValue(undefined)} {...props} />);

beforeEach(() => { api.updateCustomerProfile.mockReset(); });
afterEach(cleanup);

describe('ProfileEditCard', () => {
  it.each([
    ['gate off', { ...customer, profileEdit: false }],
    ['cancelled account', { ...customer, cancelled: true }],
    ['contact session', { ...customer, actor: { kind: 'contact' } }],
  ])('renders nothing for %s', (_label, who) => {
    const { container } = renderCard({ customer: who });
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

  it('checks only the fields that changed: a bad email blocks, an empty first name blocks', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('valid email');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat.sample@example.test' } });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    expect(screen.getByRole('alert')).toHaveTextContent('first name');
    expect(api.updateCustomerProfile).not.toHaveBeenCalled();
  });

  it('sends only the edited fields: a name-only save leaves the email out', async () => {
    api.updateCustomerProfile.mockResolvedValue({ changed: ['firstName'] });
    const refreshCustomer = vi.fn().mockResolvedValue(undefined);
    renderCard({ refreshCustomer });
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Sam ' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(refreshCustomer).toHaveBeenCalledTimes(1));
    expect(api.updateCustomerProfile).toHaveBeenCalledWith({ firstName: 'Sam' });
    expect(screen.queryByTestId('profile-edit-form')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/^Saved\.$/);
  });

  it('a customer with no email on file can change a name without entering one', async () => {
    api.updateCustomerProfile.mockResolvedValue({ changed: ['lastName'] });
    renderCard({ customer: { ...customer, email: '' } });
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(api.updateCustomerProfile).toHaveBeenCalledWith({ lastName: 'Example' }));
  });

  it('sends the email when it was edited, trimmed', async () => {
    api.updateCustomerProfile.mockResolvedValue({ changed: ['email'] });
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' new.address@example.test ' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(api.updateCustomerProfile).toHaveBeenCalledWith({ email: 'new.address@example.test' }));
  });

  it('nothing edited: no request, says there is nothing to save', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    expect(api.updateCustomerProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save.');
  });

  it('a server answer with no changed fields reads as no change, never as saved or emailed', async () => {
    api.updateCustomerProfile.mockResolvedValue({ changed: [] });
    renderCard();
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No changes to save.'));
    expect(screen.getByRole('status')).not.toHaveTextContent(/email/i);
  });

  it('shows the server message and keeps the form open when the save fails', async () => {
    api.updateCustomerProfile.mockRejectedValue(new Error('Too many profile changes. Please try again later.'));
    const refreshCustomer = vi.fn();
    renderCard({ refreshCustomer });
    fireEvent.click(screen.getByTestId('profile-edit-open'));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByTestId('profile-edit-save'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many profile changes'));
    expect(screen.getByTestId('profile-edit-form')).toBeInTheDocument();
    expect(refreshCustomer).not.toHaveBeenCalled();
  });
});
