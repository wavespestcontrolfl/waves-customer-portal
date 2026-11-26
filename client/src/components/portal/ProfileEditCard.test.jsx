// @vitest-environment jsdom
// Pins the Account-menu profile edit (GATE_CUSTOMER_PROFILE_EDIT): hidden while the gate is off, the form opens
// pre-filled, a bad email or empty first name never reaches the server, a save sends the three fields and then
// re-reads /auth/me, and a server refusal shows its message and keeps the form open.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({ default: { updateCustomerProfile: vi.fn(), confirmCustomerEmail: vi.fn() } }));

import api from '../../utils/api';
import ProfileEditCard from './ProfileEditCard';

const customer = { profileEdit: true, firstName: 'Pat', lastName: 'Sample', email: 'pat.sample@example.test', phone: '9415550100' };
const renderCard = (props = {}) => render(<ProfileEditCard customer={customer} refreshCustomer={vi.fn().mockResolvedValue(undefined)} {...props} />);

beforeEach(() => { api.updateCustomerProfile.mockReset(); api.confirmCustomerEmail.mockReset(); });
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

  describe('a new email takes two steps', () => {
    const NEW = 'new.address@example.test';
    const startEmailChange = async (extra = {}) => {
      api.updateCustomerProfile.mockResolvedValue({ changed: [], emailPending: { email: NEW, expiresInMinutes: 15 }, ...extra });
      const refreshCustomer = vi.fn().mockResolvedValue(undefined);
      renderCard({ refreshCustomer });
      fireEvent.click(screen.getByTestId('profile-edit-open'));
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: ` ${NEW} ` } });
      fireEvent.click(screen.getByTestId('profile-edit-save'));
      await screen.findByTestId('profile-code-form');
      return refreshCustomer;
    };

    it('Save sends the trimmed email, then asks for the code mailed to it; the email is not saved yet', async () => {
      const refreshCustomer = await startEmailChange();
      expect(api.updateCustomerProfile).toHaveBeenCalledWith({ email: NEW });
      expect(screen.getByTestId('profile-code-form')).toHaveTextContent(`We sent a code to ${NEW}`);
      expect(screen.queryByTestId('profile-edit-form')).toBeNull();
      expect(refreshCustomer).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('Confirm stays off until 6 digits are typed, strips non-digits, then confirms and re-reads /auth/me', async () => {
      api.confirmCustomerEmail.mockResolvedValue({ changed: ['email'] });
      const refreshCustomer = await startEmailChange();
      const confirmBtn = screen.getByTestId('profile-code-confirm');
      expect(confirmBtn).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '12a34 5' } });
      expect(screen.getByLabelText('Code')).toHaveValue('12345');
      expect(confirmBtn).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
      fireEvent.click(confirmBtn);
      await waitFor(() => expect(refreshCustomer).toHaveBeenCalledTimes(1));
      expect(api.confirmCustomerEmail).toHaveBeenCalledWith({ code: '123456', email: NEW });
      expect(screen.queryByTestId('profile-code-form')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent(/^Saved\.$/);
    });

    it('a wrong code shows the server words and keeps the code step open', async () => {
      api.confirmCustomerEmail.mockRejectedValue(new Error('That code is not right. Check the newest email and try again.'));
      const refreshCustomer = await startEmailChange();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '000000' } });
      fireEvent.click(screen.getByTestId('profile-code-confirm'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not right'));
      expect(screen.getByTestId('profile-code-form')).toBeInTheDocument();
      expect(refreshCustomer).not.toHaveBeenCalled();
    });

    it('Send a new code asks the server again for the same address and clears the typed code', async () => {
      await startEmailChange();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('profile-code-resend'));
      await waitFor(() => expect(api.updateCustomerProfile).toHaveBeenCalledTimes(2));
      expect(api.updateCustomerProfile).toHaveBeenLastCalledWith({ email: NEW });
      expect(screen.getByLabelText('Code')).toHaveValue('');
    });

    it('a resend the server limits shows its message and keeps the step open', async () => {
      await startEmailChange();
      api.updateCustomerProfile.mockRejectedValue(new Error('Too many profile changes. Please try again later.'));
      fireEvent.click(screen.getByTestId('profile-code-resend'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many profile changes'));
      expect(screen.getByTestId('profile-code-form')).toBeInTheDocument();
    });

    it('a name and a new email together: the name is saved and re-read at once, the email waits for its code', async () => {
      api.updateCustomerProfile.mockResolvedValue({ changed: ['firstName'], emailPending: { email: NEW, expiresInMinutes: 15 } });
      const refreshCustomer = vi.fn().mockResolvedValue(undefined);
      renderCard({ refreshCustomer });
      fireEvent.click(screen.getByTestId('profile-edit-open'));
      fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sam' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: NEW } });
      fireEvent.click(screen.getByTestId('profile-edit-save'));
      await screen.findByTestId('profile-code-form');
      expect(api.updateCustomerProfile).toHaveBeenCalledWith({ firstName: 'Sam', email: NEW });
      expect(refreshCustomer).toHaveBeenCalledTimes(1);
    });

    it('a combined save whose code email fails: the saved name is shown, the baseline resets, and the retry sends only the email', async () => {
      const failure = Object.assign(new Error('We could not send the code. Please try again in a moment.'), {
        status: 502, code: 'code_send_failed', changed: ['firstName'], profile: { firstName: 'Sam', lastName: 'Sample', email: 'pat.sample@example.test' },
      });
      api.updateCustomerProfile.mockRejectedValueOnce(failure);
      const refreshCustomer = vi.fn().mockResolvedValue(undefined);
      renderCard({ refreshCustomer });
      fireEvent.click(screen.getByTestId('profile-edit-open'));
      fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sam' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: NEW } });
      fireEvent.click(screen.getByTestId('profile-edit-save'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not send the code'));
      expect(refreshCustomer).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('profile-edit-form')).toBeInTheDocument();
      // Retry: the name is no longer an outstanding edit.
      api.updateCustomerProfile.mockResolvedValueOnce({ changed: [], emailPending: { email: NEW, expiresInMinutes: 15 } });
      fireEvent.click(screen.getByTestId('profile-edit-save'));
      await screen.findByTestId('profile-code-form');
      expect(api.updateCustomerProfile).toHaveBeenLastCalledWith({ email: NEW });
    });

    it('a failure that saved nothing does not refresh the customer', async () => {
      api.updateCustomerProfile.mockRejectedValueOnce(Object.assign(new Error('We could not send the code.'), { status: 502, changed: [], profile: {} }));
      const refreshCustomer = vi.fn();
      renderCard({ refreshCustomer });
      fireEvent.click(screen.getByTestId('profile-edit-open'));
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: NEW } });
      fireEvent.click(screen.getByTestId('profile-edit-save'));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(refreshCustomer).not.toHaveBeenCalled();
    });

    it('Cancel closes the code step without confirming', async () => {
      await startEmailChange();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('profile-code-form')).toBeNull();
      expect(api.confirmCustomerEmail).not.toHaveBeenCalled();
    });
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
