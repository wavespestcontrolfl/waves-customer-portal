import { useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';

// =========================================================================
// Edit my name and email (GATE_CUSTOMER_PROFILE_EDIT, owner 2026-11-26).
// Sits in the Account menu under the customer's name. The server decides
// whether the control exists: /auth/me carries profileEdit: true only while
// the gate is on, and a contact login or a cancelled account never sees it
// (the parent passes `enabled`). The phone number is the login and is not
// editable here. After a save the parent's refreshCustomer re-reads /auth/me.
// The server emails the customer about the change (an email change goes to
// the old and the new address).
// =========================================================================

const linkStyle = {
  background: 'none', border: 'none', padding: '8px 0', minHeight: 44, cursor: 'pointer',
  color: B.glassNavy, fontSize: 14, fontWeight: 700, fontFamily: FONTS.body, textAlign: 'left',
};
const inputStyle = {
  width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '10px 12px', fontSize: 16,
  border: `1px solid ${SHELL.border}`, borderRadius: 8, fontFamily: FONTS.body, color: SHELL.text, background: '#fff',
};
const labelStyle = { display: 'grid', gap: 4, fontSize: 14, fontWeight: 700, color: SHELL.muted };
const saveStyle = {
  minHeight: 44, padding: '10px 18px', borderRadius: 8, border: 'none', background: B.glassNavy, color: '#fff',
  fontSize: 16, fontWeight: 700, fontFamily: FONTS.body, cursor: 'pointer',
};
const cancelStyle = {
  minHeight: 44, padding: '10px 14px', borderRadius: 8, border: `1px solid ${SHELL.border}`, background: 'transparent',
  color: B.glassNavy, fontSize: 16, fontWeight: 600, fontFamily: FONTS.body, cursor: 'pointer',
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ProfileEditCard({ customer, enabled, refreshCustomer }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  if (!enabled) return null;

  const begin = () => {
    setForm({ firstName: customer?.firstName || '', lastName: customer?.lastName || '', email: customer?.email || '' });
    setError('');
    setSaved(false);
    setOpen(true);
  };
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim() };
    if (!next.firstName) { setError('Enter your first name.'); return; }
    if (!EMAIL_SHAPE.test(next.email)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.updateCustomerProfile(next);
      try { await refreshCustomer?.(); } catch { /* the save worked; the menu updates on the next load */ }
      setSaved(true);
      setOpen(false);
    } catch (err) {
      setError(err?.message || 'We could not save that. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div>
        <button type="button" data-testid="profile-edit-open" onClick={begin} style={linkStyle}>Edit name and email</button>
        {saved && <div role="status" style={{ fontSize: 14, color: SHELL.muted }}>Saved. We emailed you a note about the change.</div>}
      </div>
    );
  }

  return (
    <form data-testid="profile-edit-form" noValidate onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 10 }}>
      <label style={labelStyle}>First name
        <input aria-label="First name" value={form.firstName} onChange={set('firstName')} maxLength={50} autoComplete="given-name" style={inputStyle} />
      </label>
      <label style={labelStyle}>Last name
        <input aria-label="Last name" value={form.lastName} onChange={set('lastName')} maxLength={50} autoComplete="family-name" style={inputStyle} />
      </label>
      <label style={labelStyle}>Email
        <input aria-label="Email" type="email" value={form.email} onChange={set('email')} maxLength={150} autoComplete="email" inputMode="email" style={inputStyle} />
      </label>
      <div style={{ fontSize: 14, color: SHELL.muted }}>Your phone number is how you sign in, so it cannot be changed here. We email your old and new address when your email changes.</div>
      {error && <div role="alert" style={{ fontSize: 14, color: '#B42318' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy} data-testid="profile-edit-save" style={{ ...saveStyle, opacity: busy ? 0.65 : 1 }}>{busy ? 'Saving' : 'Save'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} style={cancelStyle}>Cancel</button>
      </div>
    </form>
  );
}
