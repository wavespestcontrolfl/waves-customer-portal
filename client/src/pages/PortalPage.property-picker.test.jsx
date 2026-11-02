// @vitest-environment jsdom
// Property picker keyboard place (UI audit 2026-11-02, UI-04): a pick re-keys
// the whole portal tree, so the trigger the customer used unmounts and focus
// fell to <body> in WebKit and Chromium. Focus now returns to the trigger, the
// picker that mounts after the switch takes it back, and the list moves by
// arrow keys.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyScopeSelect } from './PortalPage';

const properties = [
  { id: 'home', isPrimaryProfile: true, profileLabel: 'Primary', address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } },
  { id: 'family', isPrimaryProfile: false, profileLabel: 'Family', address: { line1: '418 Oak Ave', city: 'Bradenton', state: 'FL', zip: '34205' } },
  { id: 'lake', isPrimaryProfile: false, profileLabel: 'Lake house', address: { line1: '77 Pine Ct', city: 'Palmetto', state: 'FL', zip: '34221' } },
];

// The pending focus return is module state: each test gets its own picker id
// so one test's pick cannot reach the next test's picker.
let seq = 0;
beforeEach(() => { seq += 1; });
const picker = (props = {}) => (
  <PropertyScopeSelect id={`property-scope-${seq}`} properties={properties} currentId="home" onSelect={() => {}} switchingId={null} {...props} />
);
const trigger = () => screen.getByRole('button', { name: 'Choose which property you are viewing' });
const option = (name) => screen.getByRole('option', { name: new RegExp(`^${name}`) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PropertyScopeSelect focus', () => {
  it('a pick returns focus to the trigger and switches; the trigger names the selected property', () => {
    const onSelect = vi.fn();
    render(picker({ onSelect }));
    expect(trigger()).toHaveAccessibleDescription(/Primary.*1200 Palm Row Ct/);
    fireEvent.click(trigger());
    fireEvent.click(option('Family'));
    expect(onSelect).toHaveBeenCalledWith('family');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('while switching the trigger keeps focus and does not reopen the list', () => {
    const { rerender } = render(picker());
    fireEvent.click(trigger());
    fireEvent.click(option('Family'));
    rerender(picker({ switchingId: 'family' }));
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('the picker that mounts after the switch takes focus back', () => {
    const { unmount } = render(picker());
    fireEvent.click(trigger());
    fireEvent.click(option('Family'));
    // The switch re-keys the tree: this trigger unmounts and focus falls to <body>.
    unmount();
    expect(document.body).toHaveFocus();
    render(picker({ currentId: 'family' }));
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleDescription(/Family.*418 Oak Ave/);
  });

  it('a picker that mounts long after a pick does not take focus', () => {
    const now = Date.now();
    const { unmount } = render(picker());
    fireEvent.click(trigger());
    fireEvent.click(option('Family'));
    unmount();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    render(picker({ currentId: 'family' }));
    expect(trigger()).not.toHaveFocus();
  });

  it('Escape closes the list and returns focus to the trigger', () => {
    render(picker());
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('the open list focuses the selected option; arrows, Home and End move through it', () => {
    render(picker({ currentId: 'family' }));
    fireEvent.click(trigger());
    expect(option('Family')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(option('Lake house')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(option('Lake house')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(option('Primary')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(option('Primary')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(option('Lake house')).toHaveFocus();
  });

  it('Tab closes the list from the trigger', () => {
    render(picker());
    fireEvent.click(trigger());
    act(() => { fireEvent.keyDown(document.activeElement, { key: 'Tab' }); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });
});
