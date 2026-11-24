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

  it('ArrowRight / ArrowLeft / End / Home move the selection and stop at the ends', () => {
    render(<Harness />);
    const selected = () => screen.getByRole('option', { selected: true });
    fireEvent.keyDown(selected(), { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Pest');
    fireEvent.keyDown(selected(), { key: 'End' });
    expect(selected()).toHaveTextContent('Rodent');
    fireEvent.keyDown(selected(), { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Rodent');
    fireEvent.keyDown(selected(), { key: 'ArrowLeft' });
    expect(selected()).toHaveTextContent('Pest');
    fireEvent.keyDown(selected(), { key: 'Home' });
    expect(selected()).toHaveTextContent('Lawn');
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
