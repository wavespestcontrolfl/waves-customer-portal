import { useEffect, useState } from 'react';
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
// A name saves at once. A new email does NOT: the server mails a 6-digit code
// to the new address and writes nothing until it is typed back here (step 2,
// EmailCodeStep): Confirm, or Send a new code (the server limits how often).
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

// Which fields the customer changed since the form opened. Only these are sent and checked, so a name-only save
// never rewrites an email another session corrected meanwhile, and a customer with no email can fix a name.
function editedFields(form, opened) {
  const next = { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim() };
  const edited = {};
  for (const key of Object.keys(next)) if (next[key] !== opened[key]) edited[key] = next[key];
  return edited;
}

function fieldProblem(edited) {
  if ('firstName' in edited && !edited.firstName) return 'Enter your first name.';
  if ('email' in edited && !EMAIL_SHAPE.test(edited.email)) return 'Enter a valid email address.';
  return '';
}

// The card shows only while /auth/me says the gate is on, for an account holder whose account is active.
function profileEditAvailable(customer) {
  return customer?.profileEdit === true && customer?.cancelled !== true && customer?.actor?.kind !== 'contact';
}

const CODE_SHAPE = /^\d{6}$/;

// Step 2 of an email change: type the code mailed to the new address. Wrong, expired and too-many-tries answers come
// from the server with their own words; "Send a new code" asks again for the same address (with a 30s client cooldown
// after a resend to prevent accidental double-requests).
function EmailCodeStep({ email, busy, error, notice, onConfirm, onResend, onCancel }) {
  const [code, setCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);
  const submit = (e) => {
    e.preventDefault();
    if (CODE_SHAPE.test(code.trim())) onConfirm(code.trim());
  };
  const handleResend = async () => {
    if (busy || resendCooldown > 0) return;
    setCode('');
    await onResend();
    setResendCooldown(30);
  };
  return (
    <form data-testid="profile-code-form" noValidate onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 10 }}>
      <div style={{ fontSize: 16, color: SHELL.text }}>We sent a code to {email}. Type it here to confirm the new email. It expires in 15 minutes.</div>
      {notice && <div role="status" style={{ fontSize: 14, color: SHELL.muted }}>{notice}</div>}
      <label style={labelStyle}>6-digit code
        <input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} style={inputStyle} />
      </label>
      {error && <div role="alert" style={{ fontSize: 14, color: '#B42318' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy || !CODE_SHAPE.test(code)} data-testid="profile-code-confirm" style={{ ...saveStyle, opacity: busy || !CODE_SHAPE.test(code) ? 0.65 : 1 }}>{busy ? 'Checking' : 'Confirm'}</button>
        <button type="button" disabled={busy || resendCooldown > 0} data-testid="profile-code-resend" onClick={handleResend} style={cancelStyle}>
          {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Send a new code'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} style={cancelStyle}>Cancel</button>
      </div>
    </form>
  );
}

export default function ProfileEditCard({
  customer,
  refreshCustomer,
  pendingEmail: controlledPendingEmail,
  onPendingEmailChange,
  notice: controlledNotice,
  onNoticeChange,
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState({ firstName: '', lastName: '', email: '' });
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  // The address a code was mailed to, while step 2 of an email change is open.
  const [localPendingEmail, setLocalPendingEmail] = useState('');
  const pendingEmail = controlledPendingEmail !== undefined ? controlledPendingEmail : localPendingEmail;
  const setPendingEmail = onPendingEmailChange || setLocalPendingEmail;
  const notice = controlledNotice !== undefined ? controlledNotice : localNotice;
  const setNotice = onNoticeChange || setLocalNotice;

  if (!profileEditAvailable(customer)) return null;

  const begin = () => {
    // Trimmed, as the submitted values are: a stored value with outer spaces must not read as edited (an email-only
    // save would then send the name too, and could put back a name another session corrected meanwhile).
    const current = { firstName: (customer?.firstName || '').trim(), lastName: (customer?.lastName || '').trim(), email: (customer?.email || '').trim() };
    setOpened(current);
    setForm(current);
    setError('');
    setNotice('');
    setOpen(true);
  };
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const reload = async () => {
    try { await refreshCustomer?.(); } catch { /* the save worked; the menu updates on the next load */ }
  };

  // Asks the server to save the edited fields. A name saves now; a new email answers `emailPending` and waits for its code.
  const save = async (fields) => {
    setBusy(true);
    setError('');
    try {
      const result = await api.updateCustomerProfile(fields);
      const savedNames = Array.isArray(result?.changed) && result.changed.length > 0;
      const codeSentTo = result?.emailPending?.email;
      // No code went out for an address the code step was waiting on ("Send a new code"): the account already has
      // that address (it was confirmed in another tab), so that is saved too. Leave the code step and show the profile.
      const saved = savedNames || (Boolean(pendingEmail) && !codeSentTo);
      if (saved) await reload();
      if (codeSentTo) {
        setPendingEmail(codeSentTo);
        setNotice(savedNames ? 'Name saved.' : '');
      } else {
        setPendingEmail('');
        setNotice(saved ? 'Saved.' : 'No changes to save.');
        setOpen(false);
      }
    } catch (err) {
      // A name that saved before the code email failed is saved: show it, make it the new baseline, and let the
      // retry send only what is still outstanding (the email).
      if (Array.isArray(err?.changed) && err.changed.length && err.profile) {
        await reload();
        const saved = { firstName: err.profile.firstName ?? '', lastName: err.profile.lastName ?? '' };
        setOpened((o) => ({ ...o, ...saved }));
        setForm((f) => ({ ...f, ...saved }));
      }
      setError(err?.message || 'We could not save that. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const edited = editedFields(form, opened);
    if (!Object.keys(edited).length) { setNotice('No changes to save.'); setOpen(false); return; }
    const problem = fieldProblem(edited);
    if (problem) { setError(problem); return; }
    await save(edited);
  };

  const confirmCode = async (code) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.confirmCustomerEmail({ code, email: pendingEmail });
      await reload();
      setNotice('Saved.');
      setPendingEmail('');
      setOpen(false);
    } catch (err) {
      const base = err?.message || 'We could not check that code. Please try again.';
      const left = Number.isInteger(err?.attemptsLeft)
        ? ` (${err.attemptsLeft} ${err.attemptsLeft === 1 ? 'try' : 'tries'} left)`
        : '';
      setError(`${base}${left}`);
    } finally {
      setBusy(false);
    }
  };

  const closeCodeStep = () => { setPendingEmail(''); setError(''); setOpen(false); };

  if (pendingEmail) {
    return (
      <EmailCodeStep
        email={pendingEmail}
        busy={busy}
        error={error}
        notice={notice}
        onConfirm={confirmCode}
        onResend={() => save({ email: pendingEmail })}
        onCancel={closeCodeStep}
      />
    );
  }

  if (!open) {
    return (
      <div>
        <button type="button" data-testid="profile-edit-open" onClick={begin} style={linkStyle}>Edit name and email</button>
        {notice && <div role="status" style={{ fontSize: 14, color: SHELL.muted }}>{notice}</div>}
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
      <div style={{ fontSize: 14, color: SHELL.muted }}>Your phone number is how you sign in, so it cannot be changed here. A new email address needs a code we send to it.</div>
      {error && <div role="alert" style={{ fontSize: 14, color: '#B42318' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy} data-testid="profile-edit-save" style={{ ...saveStyle, opacity: busy ? 0.65 : 1 }}>{busy ? 'Saving' : 'Save'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} style={cancelStyle}>Cancel</button>
      </div>
    </form>
  );
}
