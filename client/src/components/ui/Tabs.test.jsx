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
  it('wires aria-controls / aria-labelledby only for tabs that have a panel, without re-render loops', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    const panel = screen.getByRole('tabpanel');
    expect(alpha).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', alpha.id);
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
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
