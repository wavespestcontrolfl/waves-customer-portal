// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TableColumnPicker, TablePagination, TableToolbar } from './TableControls';
import { UiSurface } from './UiSurface';

afterEach(cleanup);

describe('Shared table controls', () => {
  it('labels the query, passes its value to the caller, and leaves reset ownership with the caller', () => {
    const onSearchChange = vi.fn();
    const onReset = vi.fn();
    const props = { label: 'Customers', search: '', onSearchChange, onReset };
    const { rerender } = render(<TableToolbar {...props}><button>Filters</button></TableToolbar>);
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customers search' }), { target: { value: 'Example' } });
    expect(onSearchChange).toHaveBeenCalledWith('Example');
    rerender(<TableToolbar {...props} search="Example" canReset><button>Filters</button></TableToolbar>);
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('reports the current range and blocks navigation beyond either end or while loading', () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    const props = { label: 'Customers', page: 1, totalPages: 3, total: 53, pageSize: 25, onPageChange, onPageSizeChange };
    const { rerender } = render(<TablePagination {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('1–25 of 53 results');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customers rows per page' }), { target: { value: '50' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
    rerender(<TablePagination {...props} page={3} />);
    expect(screen.getByRole('status')).toHaveTextContent('51–53 of 53 results');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    rerender(<TablePagination {...props} page={2} disabled />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    rerender(<TablePagination {...props} total={0} totalPages={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('0–0 of 0 results');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('keeps identity columns visible, restores all choices, and returns focus on Escape', async () => {
    const columns = [{ id: 'name', label: 'Customer', required: true }, { id: 'property', label: 'Property' }];
    function Example() {
      const [visible, setVisible] = useState(['name', 'property']);
      return <UiSurface><TableColumnPicker label="Customers" columns={columns} visibleColumns={visible} onChange={setVisible} /></UiSurface>;
    }
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Columns' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Customers columns' });
    expect(within(dialog).getByRole('checkbox', { name: 'Customer' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Customer' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Property' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Property' })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show all' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Property' })).toBeChecked();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
