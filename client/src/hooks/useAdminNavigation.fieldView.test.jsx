// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useAdminNavigation, { AdminNavigationProvider } from './useAdminNavigation';
import { warmFieldViewLanding } from '../lib/fieldView';

vi.mock('../lib/fieldView', async (importOriginal) => ({ ...(await importOriginal()), warmFieldViewLanding: vi.fn(async () => true) }));

let navigation;
function Probe() { navigation = useAdminNavigation(); return null; }
const mount = (user) => render(<MemoryRouter><AdminNavigationProvider user={user} enabled><Probe /></AdminNavigationProvider></MemoryRouter>);
const saved = (id) => JSON.parse(localStorage.getItem(`waves_admin_navigation:${id}`) || 'null');

afterEach(() => { cleanup(); localStorage.clear(); navigation = null; warmFieldViewLanding.mockClear(); });

describe('Field view preference', () => {
  // Pre-push P1 (round 7): after a deploy the app can open on another page (a
  // push tap), so a verified session with the switch on readies Today too.
  // The module keeps one try per page; the provider asks on each mount.
  it('a verified admin session readies Today while the switch is on, from the moment it turns on', () => {
    mount({ id: 'acct-1', role: 'admin' });
    expect(warmFieldViewLanding).not.toHaveBeenCalled();
    act(() => navigation.setFieldView(true));
    expect(warmFieldViewLanding).toHaveBeenCalledTimes(1);
    expect(warmFieldViewLanding).toHaveBeenCalledWith();
    cleanup();
    mount({ id: 'acct-1', role: 'admin' });
    expect(warmFieldViewLanding).toHaveBeenCalledTimes(2);
  });
  it('a login not verified yet, or one that is not an admin, never readies Today', () => {
    for (const id of ['acct-1', 'acct-3']) localStorage.setItem(`waves_admin_navigation:${id}`, JSON.stringify({ version: 2, fieldView: true }));
    render(<MemoryRouter><AdminNavigationProvider user={{ id: 'acct-1', role: 'admin' }} enabled={false}><Probe /></AdminNavigationProvider></MemoryRouter>);
    cleanup();
    mount({ id: 'acct-3', role: 'technician' });
    expect(warmFieldViewLanding).not.toHaveBeenCalled();
  });
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
  // Pre-push P1 (rounds 3 and 4): full storage still reads, but every write
  // fails. The shell remounts this provider on every page change, and a cold
  // open reads storage, so the switch moves only when the phone saved it.
  const withFullStorage = (run) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try { run(); } finally { Storage.prototype.setItem = setItem; }
  };
  it('with full storage the switch stays as saved, also after the shell remounts', () => {
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: false }));
    mount({ id: 'acct-1', role: 'admin' });
    let result;
    withFullStorage(() => {
      act(() => navigation.togglePin('today'));
      act(() => { result = navigation.setFieldView(true); });
      act(() => { navigation.togglePin('customers'); navigation.toggleGroup(navigation.groups[0].id); });
    });
    expect(result).toBe(false);
    expect(navigation.fieldView).toBe(false);
    // Pins and groups still change in this tab until the next page.
    expect(navigation.pinnedItems.map(({ id }) => id)).toEqual(['today', 'customers']);
    expect(saved('acct-1')).toEqual({ version: 2, fieldView: false });
    cleanup();
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.fieldView).toBe(false);
  });
  it('with full storage the switch cannot turn off either', () => {
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: true }));
    mount({ id: 'acct-1', role: 'admin' });
    let result;
    withFullStorage(() => { act(() => { result = navigation.setFieldView(false); }); });
    expect(result).toBe(false);
    expect(navigation.fieldView).toBe(true);
  });
  it("when saving works again, the switch saves with this tab's unsaved pins", () => {
    mount({ id: 'acct-1', role: 'admin' });
    withFullStorage(() => { act(() => navigation.togglePin('today')); });
    let result;
    act(() => { result = navigation.setFieldView(true); });
    expect(result).toBe(true);
    expect(navigation.fieldView).toBe(true);
    expect(saved('acct-1')).toMatchObject({ fieldView: true, pins: ['today'] });
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
