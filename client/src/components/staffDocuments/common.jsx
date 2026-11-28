import { adminFetch } from '../../lib/adminFetch';
import { cloneElement, useId } from 'react';
import { etDateString, formatETDateTime } from '../../lib/timezone';
import { saveBlobNative } from '../../native/nativeFile';

// Waves Field palette — matches FieldDocument (navy #04395E, blue #009CDE, gold #F0A500).
export const D = {
  bg: '#F1F7FA',
  card: '#FFFFFF',
  border: '#D5DEE5',
  text: '#1E293B',
  muted: '#475569',
  accent: '#04395E',
  blue: '#009CDE',
  gold: '#F0A500',
  warm: '#FAF8F3',
  successBg: '#ECFDF5',
  successBorder: '#A7F3D0',
  successText: '#065F46',
};
export const box = { padding: 20, border: `1px solid ${D.border}`, borderRadius: 10, background: D.card, minWidth: 0, boxShadow: '0 1px 3px rgba(4, 57, 94, 0.05)' };
export const inputStyle = { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '10px 12px', border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 15, color: D.text, background: D.card };
export const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 };
export const buttonStyle = { minHeight: 44, padding: '10px 16px', border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, color: D.accent, background: D.card, cursor: 'pointer' };
export const primaryStyle = { ...buttonStyle, border: `1px solid ${D.accent}`, background: D.accent, color: '#FFFFFF' };

export function signedNameValid(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 3 && cleaned.length <= 180 && /^\S+(\s+\S+)+$/.test(cleaned);
}

export async function downloadPdfBlob(blob, filename) {
  if (await saveBlobNative(blob, filename)) return;
  const url = URL.createObjectURL(blob);
  const link = globalThis.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Field({ label, children }) {
  const id = useId();
  return <div style={{ display: 'grid', gap: 6, marginBottom: 14, fontSize: 14, minWidth: 0 }}><label htmlFor={id} style={{ fontWeight: 600, color: D.accent }}>{label}</label>{cloneElement(children, { id })}</div>;
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
