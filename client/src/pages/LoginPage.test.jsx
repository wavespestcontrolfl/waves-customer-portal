// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('clears a stale OTP error when returning to the phone step', async () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '9415550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Code' }));

    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('That verification code is not valid.');

    fireEvent.click(screen.getByRole('button', { name: 'Use Different Number' }));

    expect(authMocks.clearError).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
