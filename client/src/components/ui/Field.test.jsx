// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Field, Input, Select, Button, UiSurface, Sheet } from '.';

afterEach(cleanup);

describe('shared field and action behavior', () => {
  it('associates the visible label, help and error without losing caller descriptions or events', () => {
    const change = vi.fn();
    const content = (error) => <>
      <p id="existing-description">Office contact</p>
      <Field label="Email" help="Used for receipts" error={error} required>
        <Input id="customer-email" aria-describedby="existing-description" onChange={change} />
      </Field>
    </>;
    const { rerender } = render(content('Enter a valid email'));
    const field = screen.getByRole('textbox', { name: 'Email' });
    expect(field).toHaveAccessibleDescription('Office contact Used for receipts Enter a valid email');
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    for (const token of field.getAttribute('aria-describedby').split(' ')) expect(document.getElementById(token)).not.toBeNull();
    fireEvent.change(field, { target: { value: 'staff@example.invalid' } });
    expect(change).toHaveBeenCalledTimes(1);
    rerender(content(null));
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).toHaveAccessibleDescription('Office contact Used for receipts');
    expect(field).toHaveValue('staff@example.invalid');
  });

  it('names a select with a generated ID, preserving its value', () => {
    render(<Field label="Status"><Select defaultValue="active"><option value="active">Active</option></Select></Field>);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
  });

  it('keeps a loading action named and prevents repeat clicks', () => {
    const act = vi.fn();
    const { rerender } = render(<Button onClick={act} loading={false}>Save customer</Button>);
    const button = screen.getByRole('button', { name: 'Save customer' });
    fireEvent.click(button);
    rerender(<Button onClick={act} loading>Save customer</Button>);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('carries density through a portal while explicit control choices remain local', () => {
    render(<UiSurface density="touch"><Sheet open onClose={() => {}}><Input aria-label="Drawer field" /><Button density="compact">Secondary action</Button></Sheet></UiSurface>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-ui-density', 'touch');
    expect(screen.getByRole('textbox')).toHaveClass('ui-control-touch');
    expect(screen.getByRole('button')).toHaveClass('ui-control-compact');
  });
});
