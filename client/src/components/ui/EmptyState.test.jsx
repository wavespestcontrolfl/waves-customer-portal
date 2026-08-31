// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('children-only form keeps the original centered muted line', () => {
    const { container } = render(<EmptyState>No reviews yet</EmptyState>);
    const el = screen.getByText('No reviews yet');
    expect(el).toHaveClass('py-10', 'text-center', 'text-13', 'text-ink-secondary');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('title form renders headline, caption, and action', () => {
    render(
      <EmptyState
        title="No estimates yet"
        caption="Create or send an estimate before it appears here"
        action={<button type="button">CREATE ESTIMATE</button>}
      />,
    );
    expect(screen.getByText('No estimates yet')).toHaveClass('text-14', 'font-medium');
    expect(
      screen.getByText('Create or send an estimate before it appears here'),
    ).toHaveClass('text-ink-tertiary');
    expect(screen.getByRole('button', { name: 'CREATE ESTIMATE' })).toBeInTheDocument();
  });

  it('size="page" renders the 240px spec block', () => {
    render(<EmptyState size="page" title="Nothing here" />);
    expect(screen.getByText('Nothing here').parentElement).toHaveClass('min-h-[240px]');
  });
});
