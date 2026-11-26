// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

const authMocks = vi.hoisted(() => ({
  clearError: vi.fn(),
  sendCode: vi.fn(async () => true),
  verifyCode: vi.fn(async () => false),
}));

vi.mock('../hooks/useAuth', async () => {
  const React = await import('react');
  return {
    useAuth: () => {
      const [error, setError] = React.useState('That verification code is not valid.');
      return {
        ...authMocks,
        error,
        isAuthenticated: false,
        loading: false,
        clearError: () => {
          authMocks.clearError();
          setError(null);
        },
      };
    },
  };
});

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
vi.mock('../native/platform', () => ({ isNativeApp: () => false }));
vi.mock('../components/Icon', () => ({ default: () => null }));

describe('customer login recovery', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  async function reachCodeStep() {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '9415550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeInTheDocument());
  }


  it('uses account-neutral copy after a success-shaped send response', async () => {
    await reachCodeStep();

    expect(screen.getByText('If you receive a code at (941) 555-0123, enter it below.')).toBeInTheDocument();
    expect(screen.queryByText(/code sent/i)).not.toBeInTheDocument();
  });

  it('shows recovery help before any verification attempt', async () => {
    await reachCodeStep();

    expect(screen.getByText(/didn.t receive a code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use a different number' })).toBeEnabled();
    expect(screen.getAllByRole('link', { name: /call/i }).some((link) => link.getAttribute('href') === 'tel:+19412975749')).toBe(true);
    expect(authMocks.verifyCode).not.toHaveBeenCalled();
  });

  it('resends to the same phone and clears a stale OTP error when changing numbers', async () => {
    await reachCodeStep();

    expect(screen.getByRole('alert')).toHaveTextContent('That verification code is not valid.');

    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    await waitFor(() => expect(authMocks.sendCode).toHaveBeenCalledTimes(2));
    expect(authMocks.sendCode).toHaveBeenNthCalledWith(2, '+19415550123');

    fireEvent.click(screen.getByRole('button', { name: 'Use a different number' }));

    expect(authMocks.clearError).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turns an autofilled +1 number into the right 10 digits', async () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const input = screen.getByLabelText('Phone number');
    fireEvent.change(input, { target: { value: '+1 (941) 555-0147' } });
    expect(input).toHaveValue('(941) 555-0147');
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(authMocks.sendCode).toHaveBeenCalledWith('+19415550147'));
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } });
    await waitFor(() => expect(authMocks.verifyCode).toHaveBeenCalledWith('+19415550147', '123456'));
  });

  it('also drops a leading 1 typed or pasted as 11 digits', () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const input = screen.getByLabelText('Phone number');
    fireEvent.change(input, { target: { value: '19415550147' } });
    expect(input).toHaveValue('(941) 555-0147');
  });

  describe('code step', () => {
    it('signs in by itself once when 6 digits arrive, and not again after an error', async () => {
      await reachCodeStep();
      const input = screen.getByLabelText('Verification code');
      fireEvent.change(input, { target: { value: '12345' } });
      expect(authMocks.verifyCode).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: '123456' } });
      await waitFor(() => expect(authMocks.verifyCode).toHaveBeenCalledTimes(1));
      expect(authMocks.verifyCode).toHaveBeenCalledWith('+19415550123', '123456');
      await act(async () => {});
      // verifyCode returned false (wrong code): the same code is not sent again by itself.
      expect(authMocks.verifyCode).toHaveBeenCalledTimes(1);
      // A changed code is sent again.
      fireEvent.change(input, { target: { value: '654321' } });
      await waitFor(() => expect(authMocks.verifyCode).toHaveBeenCalledTimes(2));
      expect(authMocks.verifyCode).toHaveBeenLastCalledWith('+19415550123', '654321');
    });

    it('does not double submit while a verify is in flight', async () => {
      let finish;
      authMocks.verifyCode.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await reachCodeStep();
      const input = screen.getByLabelText('Verification code');
      fireEvent.change(input, { target: { value: '123456' } });
      await waitFor(() => expect(authMocks.verifyCode).toHaveBeenCalledTimes(1));
      fireEvent.submit(input.closest('form'));
      await act(async () => {});
      expect(authMocks.verifyCode).toHaveBeenCalledTimes(1);
      await act(async () => { finish(false); });
      expect(authMocks.verifyCode).toHaveBeenCalledTimes(1);
    });

    it('promises a new code only conditionally after a resend', async () => {
      await reachCodeStep();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resend code' })); });
      expect(authMocks.sendCode).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/If this number is on a Waves account, a new code is on its way/)).toBeInTheDocument();
    });



    it('does not claim a new code was sent when the resend fails', async () => {
      await reachCodeStep();
      authMocks.sendCode.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
      await waitFor(() => expect(authMocks.sendCode).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(screen.queryByText(/If this number is on a Waves account, a new code is on its way/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
    });
  });
});
