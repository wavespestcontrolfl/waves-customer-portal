// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge';
import { Button } from './Button';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Badge tones', () => {
  it('renders the alert tone', () => {
    render(<Badge tone="alert">Overdue</Badge>);
    expect(screen.getByText('Overdue')).toHaveClass('bg-alert-bg', 'text-alert-fg');
  });

  it('falls back to neutral for an unknown tone and warns in dev (F0227)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Badge tone="nope" dot>Chip</Badge>);
    const chip = screen.getByText('Chip');
    expect(chip).toHaveClass('bg-zinc-100', 'text-zinc-700');
    expect(chip.firstChild).toHaveClass('bg-zinc-500');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('unknown tone "nope"');
  });

  it('does not warn for a known tone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Badge tone="strong">Paid</Badge>);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Button variants', () => {
  it('falls back to primary / md for unknown variant and size', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Button variant="loud" size="xl">Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toHaveClass('bg-zinc-900', 'px-4', 'text-12');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
