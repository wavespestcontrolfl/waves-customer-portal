// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CustomerColumn from './CustomerColumn';

afterEach(() => cleanup());

describe('CustomerColumn', () => {
  // Outer cap = content width + both 16px gutters (border-box), so the
  // CONTENT is exactly 760 / 640 at desktop, matching the old
  // `min(100% - 32px, 760px)` recipe rather than shaving 32px off it.
  it('defaults to the document column (760 content = 792 outer)', () => {
    render(<CustomerColumn data-testid="col">content</CustomerColumn>);
    const el = screen.getByTestId('col');
    expect(el.style.maxWidth).toBe('792px');
  });

  it('renders the flow column (640 content = 672 outer) when column="flow"', () => {
    render(<CustomerColumn column="flow" data-testid="col">content</CustomerColumn>);
    const el = screen.getByTestId('col');
    expect(el.style.maxWidth).toBe('672px');
  });

  it('applies the shared gutter, top and bottom clearance, and flex: 1', () => {
    render(<CustomerColumn data-testid="col">content</CustomerColumn>);
    const el = screen.getByTestId('col');
    expect(el.style.padding).toBe('28px 16px 56px');
    expect(el.style.flex).toBe('1 1 0%'); // jsdom's normalized form of `flex: 1`
    expect(el.style.width).toBe('100%');
    expect(el.style.margin).toBe('0px auto'); // jsdom's normalized form of `margin: '0 auto'`
    expect(el.style.boxSizing).toBe('border-box');
  });

  it('passes through rest props (role, data-*, id)', () => {
    render(
      <CustomerColumn role="alert" data-glass-clear="" id="rate-alert" data-testid="col">
        content
      </CustomerColumn>,
    );
    const el = screen.getByTestId('col');
    expect(el).toHaveAttribute('role', 'alert');
    expect(el).toHaveAttribute('data-glass-clear', '');
    expect(el).toHaveAttribute('id', 'rate-alert');
  });

  it('renders as the given element via the `as` prop', () => {
    render(
      <CustomerColumn as="section" data-testid="col">
        content
      </CustomerColumn>,
    );
    expect(screen.getByTestId('col').tagName).toBe('SECTION');
  });

  it('merges caller style LAST so a single value can still be overridden', () => {
    render(
      <CustomerColumn style={{ maxWidth: 900, background: 'red' }} data-testid="col">
        content
      </CustomerColumn>,
    );
    const el = screen.getByTestId('col');
    expect(el.style.maxWidth).toBe('900px');
    expect(el.style.background).toBe('red');
    // untouched values from the primitive survive the merge
    expect(el.style.padding).toBe('28px 16px 56px');
  });
});
