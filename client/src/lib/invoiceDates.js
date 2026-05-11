import { etDateString, formatETDate } from './timezone.js';

export function invoiceDateOnly(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (match) return match[1];
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function isInvoiceDueDateOverdue(dueDate, now = new Date()) {
  const dueDateOnly = invoiceDateOnly(dueDate);
  if (!dueDateOnly) return false;
  return dueDateOnly < etDateString(now);
}

export function formatInvoiceDate(value) {
  const dateOnly = invoiceDateOnly(value);
  if (!dateOnly) return '';
  return formatETDate(`${dateOnly}T12:00:00Z`, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
