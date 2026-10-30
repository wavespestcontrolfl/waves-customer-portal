// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DispatchBoardLayout from './DispatchBoardLayout';

afterEach(cleanup);

describe('DispatchBoardLayout pane tabs', () => {
  it('uses the 14px label size and still switches panes', () => {
    render(<DispatchBoardLayout left={<div>left pane</div>} center={<div>center pane</div>} right={<div>right pane</div>} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Roster', 'Map', 'Alerts']);
    tabs.forEach((tab) => {
      expect(tab.className).toContain('text-14');
      expect(tab.className).not.toContain('text-12');
    });
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(screen.getByRole('tab', { name: 'Alerts' })).toHaveAttribute('aria-selected', 'true');
  });
});
