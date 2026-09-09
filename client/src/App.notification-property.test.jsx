// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ auth: null }));
vi.mock('./hooks/useAuth', () => ({ AuthProvider: ({ children }) => children, useAuth: () => state.auth }));
vi.mock('./pages/PortalPage', () => ({ default: () => <div>Authorized property portal</div> }));
vi.mock('./pages/LoginPage', () => ({ default: () => <div>Customer login</div> }));
vi.mock('./components/BiometricGate', () => ({ default: ({ children }) => children, useBiometricLock: () => false }));
vi.mock('./components/InstallPrompt', () => ({ default: () => null }));
vi.mock('./components/analytics/PublicFunnelTracking', () => ({ default: () => null }));
vi.mock('./glass/glass-engine', () => ({ useGlassSurface: () => {} }));
import App from './App';

beforeEach(() => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-2');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    properties: [{ id: 'property-1' }, { id: 'property-2' }], propertiesError: null, switchProperty: vi.fn() };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('keeps the old property unmounted until the authorized property switch completes', async () => {
  let complete;
  state.auth.switchProperty.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith('property-2'));
  expect(screen.queryByText('Authorized property portal')).not.toBeInTheDocument();
  state.auth.customer = { id: 'property-2' };
  await act(async () => { complete(true); view.rerender(<App />); });
  expect(await screen.findByText('Authorized property portal')).toBeInTheDocument();
  expect(state.auth.switchProperty).toHaveBeenCalledTimes(1);
});

test('refuses a notification for another account or a revoked property', async () => {
  state.auth.properties = [{ id: 'property-1' }];
  render(<App />);
  expect(await screen.findByText('Property unavailable')).toBeInTheDocument();
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
  expect(screen.queryByText('Authorized property portal')).not.toBeInTheDocument();
});

test('a failed ownership lookup or switch never renders the current property as the target', async () => {
  state.auth.switchProperty.mockResolvedValue(false);
  render(<App />);
  expect(await screen.findByText('This property could not be opened. Try again.')).toBeInTheDocument();
  expect(screen.queryByText('Authorized property portal')).not.toBeInTheDocument();
});

test('signed-out taps retain the complete authenticated destination through login', async () => {
  state.auth.customer = null;
  state.auth.isAuthenticated = false;
  render(<App />);
  expect(await screen.findByText('Customer login')).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get('next')).toBe('/?tab=visits&notificationProperty=property-2');
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

test('saved-property entries (composite ids) still resolve a notification by its profile id', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-2');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    properties: [
      { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
      { id: 'property-2:prop-z', customerId: 'property-2', propertyId: 'prop-z' },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith('property-2'));
  expect(document.body.textContent).not.toMatch(/no longer available/);
});
