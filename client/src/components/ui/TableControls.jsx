import React, { useState } from 'react';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from './Dialog';
import { Field } from './Field';
import { Input } from './Input';
import { Select } from './Select';

// Callers own the query and its reset boundary. A server-paged list and a
// filtered local batch share controls without sharing data assumptions.
export function TableToolbar({ label, search, onSearchChange, searchPlaceholder, children, onReset, canReset = false }) {
  return <section aria-label={`${label} controls`} className="flex flex-wrap items-end gap-3">
    <Field label="Search" className="min-w-0 grow basis-64">
      <Input type="search" aria-label={`${label} search`} value={search}
        placeholder={searchPlaceholder} onChange={(event) => onSearchChange(event.target.value)} />
    </Field>
    {children}
    {onReset && <Button variant="ghost" disabled={!canReset} onClick={onReset}>Reset filters</Button>}
  </section>;
}

export function TablePagination({
  label, page, totalPages, total, pageSize, onPageChange, onPageSizeChange,
  disabled = false, itemLabel = 'results', pageSizeOptions = [25, 50, 100, 500],
}) {
  const pageCount = Math.max(1, totalPages);
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const start = total > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, total);
  return <nav aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 py-3">
    <span role="status" className="text-ui-body text-ink-secondary u-nums">
      {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()} {itemLabel}
    </span>
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      {onPageSizeChange && <Field label="Rows per page" className="w-32">
        <Select aria-label={`${label} rows per page`} value={pageSize} disabled={disabled}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}>
          {pageSizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}
        </Select>
      </Field>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={disabled || currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}>Previous page</Button>
        <span className="text-ui-body u-nums">Page {currentPage} of {pageCount}</span>
        <Button variant="secondary" disabled={disabled || currentPage >= pageCount}
          onClick={() => onPageChange(currentPage + 1)}>Next page</Button>
      </div>
    </div>
  </nav>;
}

export function TableColumnPicker({ label, columns, visibleColumns, onChange }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const toggle = (id, checked) => {
    const next = new Set(visibleColumns);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(columns.filter((column) => column.required || next.has(column.id)).map((column) => column.id));
  };
  return <>
    <Button variant="secondary" aria-haspopup="dialog" aria-expanded={open} onClick={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      setOpen(true);
    }}>Columns</Button>
    <Dialog open={open} onClose={close} size="sm">
      <DialogHeader><DialogTitle>{label} columns</DialogTitle></DialogHeader>
      <DialogBody>
        <div className="grid gap-2">
          {columns.map((column) => <Checkbox key={column.id} label={column.label}
            checked={Boolean(column.required || visibleColumns.includes(column.id))} disabled={column.required}
            onChange={(event) => toggle(column.id, event.target.checked)} />)}
        </div>
        <p className="text-ui-caption text-ink-secondary mt-3">Record names and actions stay visible.</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={() => onChange(columns.map((column) => column.id))}>Show all</Button>
        <Button onClick={close}>Done</Button>
      </DialogFooter>
    </Dialog>
  </>;
}
