import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmtDate(value) {
  if (!value) return 'Not set';
  const date = value instanceof Date ? value : new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function Field({ label, value }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--surface-muted)' }}>
      <div style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.45 }}>{value || 'Not set'}</div>
    </div>
  );
}

function ContractError({ title, message }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ maxWidth: 620, width: '100%', margin: '48px auto', padding: '0 16px' }}>
        <BrandCard>
          <SerifHeading style={{ marginBottom: 12 }}>{title}</SerifHeading>
          <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.6 }}>
            {message} Give us a call and we can help - <HelpPhoneLink tone="dark" inline />.
          </p>
        </BrandCard>
      </div>
    </WavesShell>
  );
}

export default function ContractSignPage() {
  const { token } = useParams();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);
  const [form, setForm] = useState({
    initials: '',
    signedName: '',
    agreeElectronic: false,
    agreeAuthorization: false,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/contracts/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not load contract');
        return body.contract;
      })
      .then((next) => {
        if (cancelled) return;
        setContract(next);
        setForm((prev) => ({
          ...prev,
          signedName: prev.signedName || next.recipientName || '',
        }));
        setSigned(next.status === 'signed');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load contract');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  const canSubmit = useMemo(() => (
    form.initials.trim().length > 0 &&
    form.signedName.trim().length > 1 &&
    form.agreeElectronic &&
    form.agreeAuthorization &&
    !submitting
  ), [form, submitting]);

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/contracts/${encodeURIComponent(token)}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initials: form.initials.trim(),
          signedName: form.signedName.trim(),
          agreeElectronic: form.agreeElectronic,
          agreeAuthorization: form.agreeAuthorization,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not sign contract');
      setContract(body.contract);
      setSigned(true);
    } catch (err) {
      setError(err.message || 'Could not sign contract');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ padding: '64px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading contract...</div>
      </WavesShell>
    );
  }

  if (error && !contract) {
    return <ContractError title="We couldn't open that contract" message={error} />;
  }

  if (!contract) {
    return <ContractError title="We couldn't open that contract" message="The link may be expired or mistyped." />;
  }

  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ maxWidth: 760, width: '100%', margin: '32px auto 64px', padding: '0 16px' }}>
        <BrandCard padding={28}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
            <div>
              <SerifHeading style={{ marginBottom: 8 }}>AutoPay Authorization</SerifHeading>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 15, lineHeight: 1.55 }}>
                Review the authorization below, then sign electronically.
              </p>
            </div>
            <div style={{
              fontSize: 14,
              textTransform: 'uppercase',
              letterSpacing: 0,
              color: signed ? '#166534' : 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '6px 10px',
              whiteSpace: 'nowrap',
            }}>
              {signed ? 'Signed' : 'Ready'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 18 }}>
            <Field label="Recipient" value={contract.recipientName} />
            <Field label="Payment Method" value={contract.paymentMethodLabel} />
            <Field label="Renewal Date" value={fmtDate(contract.renewalDate)} />
            <Field label="Cancellation Deadline" value={fmtDate(contract.cancellationDeadline)} />
          </div>

          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: '#FFFFFF',
            padding: 18,
            maxHeight: 360,
            overflow: 'auto',
            whiteSpace: 'pre-line',
            fontSize: 14,
            lineHeight: 1.65,
            color: 'var(--text)',
            marginBottom: 18,
          }}>
            {contract.contractTextSnapshot}
          </div>

          {signed ? (
            <div style={{ border: '1px solid #BBF7D0', background: '#F0FDF4', color: '#14532D', borderRadius: 10, padding: 16, lineHeight: 1.55 }}>
              Signed on {fmtDate(contract.signedAt)} as {contract.signedName || contract.recipientName}. Waves has recorded your electronic signature and authorization.
            </div>
          ) : (
            <form onSubmit={submit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
                <label style={{ display: 'block' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Initials</div>
                  <input
                    value={form.initials}
                    onChange={(e) => update('initials', e.target.value.toUpperCase())}
                    style={{ width: '100%', height: 44, borderRadius: 8, border: '1px solid var(--border-strong)', padding: '0 12px', fontSize: 16, boxSizing: 'border-box' }}
                    maxLength={20}
                  />
                </label>
                <label style={{ display: 'block' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Typed Signature</div>
                  <input
                    value={form.signedName}
                    onChange={(e) => update('signedName', e.target.value)}
                    style={{ width: '100%', height: 44, borderRadius: 8, border: '1px solid var(--border-strong)', padding: '0 12px', fontSize: 16, boxSizing: 'border-box' }}
                  />
                </label>
              </div>

              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10, color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>
                <input type="checkbox" checked={form.agreeElectronic} onChange={(e) => update('agreeElectronic', e.target.checked)} style={{ marginTop: 3 }} />
                <span>I agree to receive and sign this authorization electronically.</span>
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16, color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>
                <input type="checkbox" checked={form.agreeAuthorization} onChange={(e) => update('agreeAuthorization', e.target.checked)} style={{ marginTop: 3 }} />
                <span>I authorize Waves to keep the listed payment method on file and use it for future agreed service payments until I revoke authorization.</span>
              </label>

              {error && (
                <div style={{ marginBottom: 14, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 12, fontSize: 14 }}>
                  {error}
                </div>
              )}

              <BrandButton type="submit" disabled={!canSubmit} fullWidth>
                {submitting ? 'Signing...' : 'Sign Authorization'}
              </BrandButton>
            </form>
          )}
        </BrandCard>
      </div>
    </WavesShell>
  );
}
