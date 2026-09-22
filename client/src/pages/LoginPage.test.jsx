// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
