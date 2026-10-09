// @vitest-environment jsdom
// A logged-out visit to the lawn report button's target, /?tab=property#irrigation, goes to /login?next=... and comes
// back to the same path, query AND hash after the code is verified (App.jsx ProtectedRoute builds `next` from
// pathname + search + hash; LoginPage navigates to it).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authed: false }));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: auth.authed,
    loading: false,
    error: null,
    customer: null,
    properties: [],
    propertiesError: null,
    clearError: vi.fn(),
    sendCode: vi.fn(async () => true),
    verifyCode: vi.fn(async () => { auth.authed = true; return true; }),
    switchProperty: vi.fn(),
    refreshProperties: vi.fn(),
  }),
}));
vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
vi.mock('../native/platform', () => ({ isNativeApp: () => false }));
vi.mock('../components/Icon', () => ({ default: () => null }));

import LoginPage from './LoginPage';
import { ProtectedRoute } from '../App';

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}{location.search}{location.hash}</output>;
}

describe('the report button target survives the login round trip', () => {
  beforeEach(() => { auth.authed = false; });
  afterEach(cleanup);

  it('logged out: / with ?tab=property#irrigation redirects to login with the whole target in next, and returns to it with the hash', async () => {
    render(
      <MemoryRouter initialEntries={['/?tab=property#irrigation']}>
        <Where />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><div>Portal home</div></ProtectedRoute>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?next='));
    const login = screen.getByTestId('where').textContent;
    expect(new URLSearchParams(login.split('?').slice(1).join('?')).get('next')).toBe('/?tab=property#irrigation');

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '9415550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify|sign in|continue/i }));

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/?tab=property#irrigation'));
    expect(await screen.findByText('Portal home')).toBeInTheDocument();
  });
});
