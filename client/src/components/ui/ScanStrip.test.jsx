// @vitest-environment jsdom
// ui/ScanStrip: listbox semantics, tap-to-select and arrow-key selection.
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanStrip } from './ScanStrip';

afterEach(cleanup);

const ITEMS = [
  { key: 'a', label: '12 visits', value: 'Lawn' },
  { key: 'b', label: '6 templates', value: 'Pest' },
  { key: 'c', label: '3 templates', value: 'Rodent', ariaLabel: 'Rodent program' },
];

function Harness({ onSelect = () => {} }) {
  const [key, setKey] = useState('a');
  return (
    <ScanStrip
      items={ITEMS}
      selectedKey={key}
      ariaLabel="Program"
      onSelect={(k) => { setKey(k); onSelect(k); }}
    />
  );
}

describe('ui/ScanStrip', () => {
  it('renders one option per item with aria-selected on the selected tile only', () => {
    render(<Harness />);
    expect(screen.getByRole('listbox', { name: 'Program' })).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(options.map((o) => o.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('option', { name: 'Rodent program' })).toBeInTheDocument();
  });

  it('calls onSelect with the tile key on click', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('option', { name: /Pest/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.getByRole('option', { name: /Pest/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowRight / ArrowLeft / End / Home move focus only; Enter picks', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const focused = () => document.activeElement;
    const start = screen.getByRole('option', { selected: true });
    start.focus();
    fireEvent.keyDown(focused(), { key: 'ArrowRight' });
    expect(focused()).toHaveTextContent('Pest');
    fireEvent.keyDown(focused(), { key: 'End' });
    expect(focused()).toHaveTextContent('Rodent');
    fireEvent.keyDown(focused(), { key: 'ArrowRight' });
    expect(focused()).toHaveTextContent('Rodent');
    fireEvent.keyDown(focused(), { key: 'ArrowLeft' });
    expect(focused()).toHaveTextContent('Pest');
    fireEvent.keyDown(focused(), { key: 'Home' });
    expect(focused()).toHaveTextContent('Lawn');
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(focused(), { key: 'ArrowRight' });
    fireEvent.click(focused()); // Enter / Space on a <button> fire click
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('scrolls only the strip, never the page', () => {
    const pageScroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = pageScroll;
    try {
      render(<Harness />);
      fireEvent.keyDown(screen.getByRole('option', { selected: true }), { key: 'End' });
      expect(pageScroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
