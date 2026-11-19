// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import useAdminNavigation, { AdminNavigationProvider } from './useAdminNavigation';

let navigation;
function Probe() { navigation = useAdminNavigation(); return null; }
const mount = (user) => render(<MemoryRouter><AdminNavigationProvider user={user} enabled><Probe /></AdminNavigationProvider></MemoryRouter>);
const saved = (id) => JSON.parse(localStorage.getItem(`waves_admin_navigation:${id}`) || 'null');

afterEach(() => { cleanup(); localStorage.clear(); navigation = null; });

describe('Field view preference', () => {
  it('is off by default', () => {
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(false);
  });
  it('round-trips through this phone\'s storage and keeps the other saved settings', () => {
    mount({ id: 'acct-1', role: 'admin' });
    act(() => navigation.togglePin('today'));
    act(() => navigation.setFieldView(true));
    expect(navigation.fieldView).toBe(true);
    expect(saved('acct-1')).toMatchObject({ fieldView: true, version: 2 });
    expect(saved('acct-1').pins).toEqual(['today']);
    cleanup();
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(true);
    act(() => navigation.setFieldView(false));
    expect(saved('acct-1').fieldView).toBe(false);
  });
  it('survives the version change that drops saved groups', () => {
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 1, groups: { sales: true }, fieldView: true }));
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(true);
    expect(navigation.expanded.sales).toBeUndefined();
  });
  it('is saved per account id', () => {
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: true }));
    mount({ id: 'acct-2', role: 'admin' });
    expect(navigation.fieldView).toBe(false);
  });
  it('reads a missing or non-boolean value as off', () => {
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: 'yes' }));
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(false);
  });
  // Pre-push P1: another tab on this phone can change the switch.
  it("takes another tab's change at once, and ignores other keys", () => {
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(false);
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: true }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_navigation:acct-2' })); });
    expect(navigation.fieldView).toBe(false);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_navigation:acct-1' })); });
    expect(navigation.fieldView).toBe(true);
    localStorage.clear();
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    expect(navigation.fieldView).toBe(false);
  });
  it("a menu change in a tab that missed another tab's switch keeps the newest saved value", () => {
    mount({ id: 'acct-1', role: 'admin' });
    // Another tab turned Field view on; this tab has had no event yet.
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, groups: {}, pins: [], fieldView: true }));
    act(() => navigation.togglePin('today'));
    expect(saved('acct-1')).toMatchObject({ fieldView: true, pins: ['today'] });
    expect(navigation.fieldView).toBe(true);
  });
  // Pre-push P1 (round 2): the switch, a pin or a group in a tab that missed
  // another tab's pin keeps that pin; another tab's pins show at once.
  const otherTabSaved = (fields) => localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, groups: {}, pins: [], fieldView: false, ...fields }));
  it("the switch in a tab that missed another tab's pin keeps that pin", () => {
    mount({ id: 'acct-1', role: 'admin' });
    otherTabSaved({ pins: ['today'] });
    act(() => navigation.setFieldView(true));
    expect(saved('acct-1')).toMatchObject({ fieldView: true, pins: ['today'] });
    expect(navigation.pinnedItems.map(({ id }) => id)).toEqual(['today']);
  });
  it("a pin in a tab that missed another tab's pin keeps both", () => {
    mount({ id: 'acct-1', role: 'admin' });
    otherTabSaved({ pins: ['today'] });
    act(() => navigation.togglePin('customers'));
    expect(saved('acct-1').pins).toEqual(['today', 'customers']);
  });
  // The app runs in StrictMode, which renders twice in development: a change
  // queued behind another change in the same event runs twice. One pin tap
  // must still pin exactly once.
  it('one pin tap pins once under StrictMode, also behind another change', () => {
    render(<React.StrictMode><MemoryRouter><AdminNavigationProvider user={{ id: 'acct-1', role: 'admin' }} enabled><Probe /></AdminNavigationProvider></MemoryRouter></React.StrictMode>);
    act(() => { navigation.setFieldView(true); navigation.togglePin('customers'); });
    expect(saved('acct-1')).toMatchObject({ fieldView: true, pins: ['customers'] });
    expect(navigation.pinnedItems.map(({ id }) => id)).toEqual(['customers']);
  });
  // Pre-push P1 (round 3): full storage still reads, but every write fails.
  it("keeps this tab's unsaved change when the phone's storage is full", () => {
    mount({ id: 'acct-1', role: 'admin' });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      act(() => navigation.setFieldView(true));
      act(() => navigation.togglePin('today'));
      act(() => { navigation.togglePin('customers'); navigation.toggleGroup(navigation.groups[0].id); });
    } finally { Storage.prototype.setItem = setItem; }
    expect(navigation.fieldView).toBe(true);
    expect(navigation.pinnedItems.map(({ id }) => id)).toEqual(['today', 'customers']);
    expect(saved('acct-1')).toBeNull();
  });
  it("another tab's pins show here at once", () => {
    mount({ id: 'acct-1', role: 'admin' });
    otherTabSaved({ pins: ['today'] });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_navigation:acct-1' })); });
    expect(navigation.pinnedItems.map(({ id }) => id)).toEqual(['today']);
  });
  it('never applies to a login that is not an admin', () => {
    localStorage.setItem('waves_admin_navigation:acct-3', JSON.stringify({ version: 2, fieldView: true }));
    mount({ id: 'acct-3', role: 'technician' });
    expect(navigation.fieldView).toBe(false);
  });
});
