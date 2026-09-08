// @vitest-environment jsdom
// ui/Tabs: keyboard model + aria wiring. Guards the two regressions Codex
// caught on #4109: a dangling aria-controls when Tabs is a bare filter strip,
// and an unstable registerPanel that looped the TabPanel mount effect.
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs, TabList, Tab, TabPanel } from './Tabs';

afterEach(cleanup);

function Harness({ withPanels = true, initial = 'a' }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabList>
        <Tab value="a">Alpha</Tab>
        <Tab value="b">Beta</Tab>
        <Tab value="c" disabled>Gamma</Tab>
      </TabList>
      {withPanels && <TabPanel value="a">Panel A</TabPanel>}
      {withPanels && <TabPanel value="b">Panel B</TabPanel>}
    </Tabs>
  );
}

describe('ui/Tabs', () => {
  it('retains an opted-in draft while hidden, and discards it when the record changes', () => {
    function Draft() {
      const [draft, setDraft] = useState('');
      return <input aria-label="Visit notes" value={draft} onChange={(event) => setDraft(event.target.value)} />;
    }
    function Record({ customer, canBill = true }) {
      const [value, setValue] = useState('notes');
      return <Tabs key={customer} value={value} onValueChange={setValue}>
        <TabList><Tab value="notes">Notes</Tab>{canBill && <Tab value="billing">Billing</Tab>}</TabList>
        <TabPanel value="notes" keepMounted className="flex" style={{ display: 'flex' }}><Draft /></TabPanel>
        {canBill && <TabPanel value="billing" keepMounted><input aria-label="Billing draft" /></TabPanel>}
      </Tabs>;
    }
    const { rerender } = render(<Record customer="first" />);
    const notes = screen.getByRole('textbox', { name: 'Visit notes' });
    fireEvent.change(notes, { target: { value: 'Draft for the first customer' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    const hiddenPanel = notes.closest('[role="tabpanel"]');
    expect(hiddenPanel).toHaveAttribute('hidden');
    expect(hiddenPanel).toHaveAttribute('inert');
    expect(hiddenPanel).toHaveStyle({ display: 'none' });
    expect(screen.queryByRole('textbox', { name: 'Visit notes' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('textbox', { name: 'Visit notes' })).toHaveValue('Draft for the first customer');
    expect(hiddenPanel).not.toHaveAttribute('inert');
    rerender(<Record customer="second" canBill={false} />);
    expect(screen.getByRole('textbox', { name: 'Visit notes' })).toHaveValue('');
    expect(screen.queryByLabelText('Billing draft')).toBeNull();
  });

  it('wires aria-controls / aria-labelledby only for tabs that have a panel, without re-render loops', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    const panel = screen.getByRole('tabpanel');
    expect(alpha).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', alpha.id);
    expect(alpha).toHaveAttribute('tabindex', '0');
    const beta = screen.getByRole('tab', { name: 'Beta' });
    expect(beta).toHaveAttribute('tabindex', '-1');
    // The inactive panel is not in the DOM, so its tab claims no aria-controls.
    expect(beta).not.toHaveAttribute('aria-controls');
    fireEvent.click(beta);
    const panelB = screen.getByRole('tabpanel');
    expect(beta).toHaveAttribute('aria-controls', panelB.id);
    expect(alpha).not.toHaveAttribute('aria-controls');
    expect(document.getElementById(beta.getAttribute('aria-controls'))).toBe(panelB);
  });

  it('claims no aria-controls when used as a bare filter strip', () => {
    render(<Harness withPanels={false} />);
    expect(screen.getByRole('tab', { name: 'Alpha' })).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('moves focus and selection with Arrow / Home / End, skipping disabled tabs', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    const beta = screen.getByRole('tab', { name: 'Beta' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(beta);
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B');
    fireEvent.keyDown(beta, { key: 'ArrowRight' }); // wraps past disabled Gamma
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta, { key: 'Home' });
    expect(document.activeElement).toBe(alpha);
  });
});
