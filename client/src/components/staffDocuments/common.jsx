import { adminFetch } from '../../lib/adminFetch';
import { cloneElement, useId } from 'react';
import { etDateString, formatETDateTime } from '../../lib/timezone';

export const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#D4D4D8', text: '#27272A', muted: '#52525B', accent: '#18181B' };
export const box = { padding: 20, border: `1px solid ${D.border}`, borderRadius: 10, background: D.card, minWidth: 0 };
export const inputStyle = { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '10px 12px', border: `1px solid ${D.border}`, borderRadius: 6, fontSize: 14, color: D.text, background: D.card };
export const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 };
export const buttonStyle = { minHeight: 44, padding: '10px 16px', border: `1px solid ${D.border}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: D.text, background: D.card, cursor: 'pointer' };
export const primaryStyle = { ...buttonStyle, background: D.accent, color: '#FFFFFF' };

export function Field({ label, children }) {
  const id = useId();
  return <div style={{ display: 'grid', gap: 6, marginBottom: 14, fontSize: 14, minWidth: 0 }}><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}

export async function request(path, body, signal) {
  const response = await adminFetch(`/tech/staff-documents${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal,
    body,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Unable to load staff documents.');
  }
  return response.headers.get('content-type')?.includes('application/pdf') ? response.blob() : response.json();
}

export function dateLabel(value) {
  return value ? formatETDateTime(value, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not issued';
}

export function reviewLabel(value) {
  if (!value) return 'Unscheduled';
  return `${value}${value < etDateString() ? ' — review overdue' : ''}`;
}
