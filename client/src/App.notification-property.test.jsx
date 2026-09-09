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

test('a push that names the saved property switches by the (profile, property) pair even on the current profile', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-b');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [
      { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
      { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-b' }));
});

test('a profile-only push for the current profile while its PRIMARY is selected: no switch', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [{ id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true }, { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false }],
    propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await new Promise((r) => setTimeout(r, 50));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

test('a push naming a saved property that is no longer listed re-reads the list ONCE, then shows the unavailable notice, no switch', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-gone');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [{ id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' }],
    propertiesError: null, switchProperty: vi.fn(async () => true), refreshProperties: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toMatch(/no longer available/));
  expect(state.auth.refreshProperties).toHaveBeenCalledTimes(1);
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

// A house added after this tab last loaded its list (warm app session, an
// in-app bell tap): valid on the server, absent in memory — the list is
// re-read before the target is judged (GitHub codex r10 P2).
test('a push naming a saved property the STALE list lacks switches once the re-read lists it', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-new');
  const fresh = [
    { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
    { id: 'property-1:prop-new', customerId: 'property-1', propertyId: 'prop-new', isPrimaryProperty: false },
  ];
  let view;
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [{ id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true }],
    propertiesError: null, switchProperty: vi.fn(async () => true),
    refreshProperties: vi.fn(async () => { state.auth = { ...state.auth, properties: fresh }; view.rerender(<App />); return true; }) };
  view = render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-new' }));
  expect(state.auth.refreshProperties).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toMatch(/no longer available/);
});

test('a push naming a listed saved property never re-reads the list', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-b');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [
      { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
      { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
    ],
    propertiesError: null, switchProperty: vi.fn(async () => true), refreshProperties: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-b' }));
  expect(state.auth.refreshProperties).not.toHaveBeenCalled();
});

test('a profile-only push for the current profile while a NON-primary house is selected falls back to that profile\'s primary', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [
      { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
      { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-a' }));
});

test('a profile-only push under a NON-primary selection stays pending while the list is unavailable, then switches to the primary once it arrives', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [], propertiesError: null, switchProperty: vi.fn(async () => true) };
  const view = render(<App />);
  await new Promise((r) => setTimeout(r, 50));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/no longer available/);
  state.auth = { ...state.auth, properties: [
    { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
    { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
  ] };
  view.rerender(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-a' }));
});

test('a profile-only push under a NON-primary selection with a FAILED list read fails closed', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [], propertiesError: 'Other service properties are temporarily unavailable.', switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toMatch(/could not be checked/));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

test('an ACCOUNT-WIDE push (Billing) for the current profile needs only the profile: no primary fallback, no "unavailable" when the primary was retired (uncapped codex r1r P1)', async () => {
  window.history.replaceState({}, '', '/?tab=billing&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    // The primary was retired: only the secondary is listed.
    properties: [{ id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false }],
    propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  expect(await screen.findByText('Authorized property portal')).toBeInTheDocument();
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/no longer available/);
});

test('a PROPERTY-scoped push (Visits) for the same profile with a retired primary still fails closed', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [{ id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false }],
    propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toMatch(/no longer available/));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

test('a house hint on a PROFILE-shaped list (gate off / rolled back) degrades to a profile link: current profile → no switch, no "unavailable" (uncapped codex r1t P1)', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-b');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: null,
    properties: [{ id: 'property-1' }, { id: 'property-2' }], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  expect(await screen.findByText('Authorized property portal')).toBeInTheDocument();
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/no longer available/);
});

test('the same hint on a SAVED-shaped list still switches to the named house', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-b');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [
      { id: 'property-1:prop-a', key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
      { id: 'property-1:prop-b', key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith({ customerId: 'property-1', propertyId: 'prop-b' }));
});

test('a house hint on a CUSTOMER-WIDE destination (Documents) is ignored: the current profile opens even when that house is retired (uncapped codex r1v P1)', async () => {
  window.history.replaceState({}, '', '/?tab=documents&notificationProperty=property-1&notificationPropertyId=prop-retired');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [
      { id: 'property-1:prop-a', key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
      { id: 'property-1:prop-b', key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  expect(await screen.findByText('Authorized property portal')).toBeInTheDocument();
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/no longer available/);
});

test('the same retired-house hint on a PROPERTY-scoped destination (Visits) still fails closed', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-retired');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' },
    properties: [
      { id: 'property-1:prop-a', key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
      { id: 'property-1:prop-b', key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
    ], propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toMatch(/no longer available/));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});

test('a CUSTOMER-WIDE push (Billing) to a sibling profile the saved list omits (its houses all retired) still switches by profile — ownership is verified by the switch (uncapped codex r1x P1)', async () => {
  window.history.replaceState({}, '', '/?tab=billing&notificationProperty=property-9');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [{ id: 'property-1:prop-a', key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true }],
    propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledWith('property-9'));
  expect(document.body.textContent).not.toMatch(/no longer available/);
});

test('the same unlisted sibling profile on a PROPERTY-scoped push (Visits) is refused', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-9');
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' },
    selectedProperty: { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' },
    properties: [{ id: 'property-1:prop-a', key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true }],
    propertiesError: null, switchProperty: vi.fn(async () => true) };
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toMatch(/no longer available/));
  expect(state.auth.switchProperty).not.toHaveBeenCalled();
});


// The switch guard is released once the destination is satisfied: leaving
// the notified house and coming Back to the same notification URL switches
// again instead of loading forever (uncapped codex r2d P1).
test('returning to a notification URL after a manual switch away switches again', async () => {
  window.history.replaceState({}, '', '/?tab=visits&notificationProperty=property-1&notificationPropertyId=prop-b');
  const list = [
    { id: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a', isPrimaryProperty: true },
    { id: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b', isPrimaryProperty: false },
  ];
  const onA = { key: 'property-1:prop-a', customerId: 'property-1', propertyId: 'prop-a' };
  const onB = { key: 'property-1:prop-b', customerId: 'property-1', propertyId: 'prop-b' };
  state.auth = { isAuthenticated: true, loading: false, customer: { id: 'property-1' }, selectedProperty: onA, properties: list, propertiesError: null, switchProperty: vi.fn(async () => true) };
  const view = render(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledTimes(1));
  state.auth = { ...state.auth, selectedProperty: onB };
  view.rerender(<App />);
  await screen.findByText('Authorized property portal');
  state.auth = { ...state.auth, selectedProperty: onA };
  view.rerender(<App />);
  await waitFor(() => expect(state.auth.switchProperty).toHaveBeenCalledTimes(2));
  expect(state.auth.switchProperty).toHaveBeenLastCalledWith({ customerId: 'property-1', propertyId: 'prop-b' });
});
