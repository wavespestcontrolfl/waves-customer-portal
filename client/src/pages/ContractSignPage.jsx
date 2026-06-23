import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
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

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    neutral: { bg: '#FAF8F3', color: 'var(--text)', border: '#E7E2D7' },
    ready: { bg: 'var(--brand-soft)', color: 'var(--brand)', border: 'var(--brand-ring)' },
    signed: { bg: '#F0FDF4', color: '#047857', border: '#BBF7D0' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '5px 9px',
      borderRadius: 8,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: 12,
      fontWeight: 850,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ minWidth: 0, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', fontWeight: 850, color: 'var(--text-muted)', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.45, fontWeight: 650 }}>{value || 'Not set'}</div>
    </div>
  );
}

function ContractError({ title, message }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div className="waves-contract-page waves-contract-single">
        <BrandCard padding={28}>
          <StatusPill>Contract unavailable</StatusPill>
          <SerifHeading style={{ marginTop: 14, marginBottom: 12 }}>{title}</SerifHeading>
          <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.6 }}>
            {message} Give us a call and we can help - <HelpPhoneLink tone="dark" inline />.
          </p>
        </BrandCard>
      </div>
    </WavesShell>
  );
}

function AgreementRow({ checked, onChange, children }) {
  return (
    <label style={{
      display: 'flex',
      gap: 11,
      alignItems: 'flex-start',
      padding: '12px 0',
      borderTop: '1px solid var(--border)',
      color: 'var(--text)',
      fontSize: 14,
      lineHeight: 1.5,
      cursor: 'pointer',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--brand)' }}
      />
      <span>{children}</span>
    </label>
  );
}

const inputStyle = {
  width: '100%',
  height: 46,
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  padding: '0 12px',
  fontSize: 15,
  color: 'var(--text)',
  boxSizing: 'border-box',
  outline: 'none',
};

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
    agreeDocumentTerms: false,
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

  const canSubmit = useMemo(() => {
    if (contract?.requiresSignature === false) return false;
    const isAutopayContract = contract?.contractType === 'autopay_authorization';
    const acceptedTerms = isAutopayContract ? form.agreeAuthorization : form.agreeDocumentTerms;
    return (
      form.initials.trim().length > 0 &&
      form.signedName.trim().length > 1 &&
      form.agreeElectronic &&
      acceptedTerms &&
      !submitting
    );
  }, [contract?.contractType, form, submitting]);

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
          agreeAuthorization: contract?.contractType === 'autopay_authorization' ? form.agreeAuthorization : false,
          agreeDocumentTerms: contract?.contractType === 'autopay_authorization' ? false : form.agreeDocumentTerms,
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
        <div className="waves-contract-page waves-contract-single">
          <BrandCard padding={28}>
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading contract...</div>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  if (error && !contract) {
    return <ContractError title="We could not open that contract" message={error} />;
  }

  if (!contract) {
    return <ContractError title="We could not open that contract" message="The link may be expired or mistyped." />;
  }

  const isAutopay = contract.contractType === 'autopay_authorization';
  const needsSignature = contract.requiresSignature !== false;
  const signedLabel = signed ? 'Signed' : needsSignature ? 'Ready to sign' : 'Ready to view';
  const documentTitle = contract.title || (isAutopay ? 'AutoPay Authorization' : 'Document');
  const documentKind = isAutopay ? 'authorization' : 'document';
  const termsLabel = isAutopay ? 'Authorization terms' : needsSignature ? 'Document terms' : 'Document details';

  return (
    <WavesShell variant="customer" topBar="solid">
      <div className="waves-contract-page">
        <div className="waves-flow-header">
          <div>
            <StatusPill tone={signed ? 'signed' : 'ready'}>{signedLabel}</StatusPill>
            <SerifHeading style={{ marginTop: 14, marginBottom: 8 }}>{documentTitle}</SerifHeading>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 16, lineHeight: 1.55, maxWidth: 660 }}>
              {isAutopay
                ? 'Review the saved-payment authorization, then sign electronically to keep AutoPay active for approved Waves services.'
                : needsSignature
                  ? 'Review this Waves document, then sign electronically to acknowledge and accept the terms shown below.'
                  : 'Review this Waves document. No signature is required.'}
            </p>
          </div>
        </div>

        <div className="waves-contract-grid">
          <BrandCard padding={28}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--brand-soft)',
                  color: 'var(--brand)',
                }}>
                  <Icon name="document" size={22} strokeWidth={2} />
                </span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--text)' }}>{documentTitle}</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>Waves Pest Control</div>
                </div>
              </div>
              <StatusPill tone={signed ? 'signed' : 'ready'}>{signedLabel}</StatusPill>
            </div>

            <div className="waves-contract-fields">
              <Field label="Recipient" value={contract.recipientName} />
              {isAutopay ? (
                <>
                  <Field label="Payment Method" value={contract.paymentMethodLabel} />
                  <Field label="Renewal Date" value={fmtDate(contract.renewalDate)} />
                  <Field label="Cancellation Deadline" value={fmtDate(contract.cancellationDeadline)} />
                </>
              ) : (
                <>
                  <Field label="Document Type" value={contract.documentTemplateKey || contract.contractType} />
                  <Field label="Service" value={contract.serviceName || 'Waves service'} />
                  <Field label="Requested" value={fmtDate(contract.sharedAt || contract.createdAt)} />
                </>
              )}
            </div>

            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase', marginBottom: 8 }}>{termsLabel}</div>
              <div style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: '#FFFFFF',
                padding: 18,
                maxHeight: 420,
                overflow: 'auto',
                whiteSpace: 'pre-line',
                fontSize: 14,
                lineHeight: 1.65,
                color: 'var(--text)',
              }}>
                {contract.contractTextSnapshot}
              </div>
              {!signed && (
                <a
                  href={`${API_BASE}/contracts/${encodeURIComponent(token)}?format=pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    marginTop: 14,
                    fontSize: 14,
                    fontWeight: 750,
                    color: 'var(--brand)',
                    textDecoration: 'none',
                  }}
                >
                  <Icon name="download" size={16} strokeWidth={2} />
                  Download PDF
                </a>
              )}
            </div>
          </BrandCard>

          <BrandCard padding={24} style={{ position: 'sticky', top: 20 }}>
            {signed ? (
              <div>
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#F0FDF4',
                  color: '#047857',
                  marginBottom: 14,
                }}>
                  <Icon name="checkCircle" size={24} strokeWidth={2} />
                </div>
                <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--text)' }}>{isAutopay ? 'Authorization' : 'Document'} signed</div>
                <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.55 }}>
                  Signed on {fmtDate(contract.signedAt)} as {contract.signedName || contract.recipientName}. Waves has recorded your electronic signature{isAutopay ? ' and authorization' : ''}.
                </p>
              </div>
            ) : !needsSignature ? (
              <div>
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--brand-soft)',
                  color: 'var(--brand)',
                  marginBottom: 14,
                }}>
                  <Icon name="document" size={24} strokeWidth={2} />
                </div>
                <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--text)' }}>No signature required</div>
                <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.55 }}>
                  This Waves document is ready to view. You can save this link or reply to the message that sent it if you have questions.
                </p>
                <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Need help? <HelpPhoneLink tone="dark" inline />
                </div>
              </div>
            ) : (
              <form onSubmit={submit}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <span style={{
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--brand-soft)',
                    color: 'var(--brand)',
                  }}>
                    <Icon name="pencil" size={18} strokeWidth={2} />
                  </span>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 850, color: 'var(--text)' }}>Sign {documentKind}</div>
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>Both fields and agreements are required.</div>
                  </div>
                </div>

                <label style={{ display: 'block', marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase', marginBottom: 7 }}>Initials</div>
                  <input
                    name="initials"
                    value={form.initials}
                    onChange={(e) => update('initials', e.target.value.toUpperCase())}
                    style={inputStyle}
                    maxLength={20}
                    autoComplete="off"
                  />
                </label>

                <label style={{ display: 'block', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase', marginBottom: 7 }}>Typed Signature</div>
                  <input
                    name="signedName"
                    value={form.signedName}
                    onChange={(e) => update('signedName', e.target.value)}
                    style={inputStyle}
                    autoComplete="name"
                  />
                </label>

                <AgreementRow checked={form.agreeElectronic} onChange={(checked) => update('agreeElectronic', checked)}>
                  I agree to receive and sign this {documentKind} electronically.
                </AgreementRow>
                <AgreementRow
                  checked={isAutopay ? form.agreeAuthorization : form.agreeDocumentTerms}
                  onChange={(checked) => update(isAutopay ? 'agreeAuthorization' : 'agreeDocumentTerms', checked)}
                >
                  {isAutopay
                    ? 'I authorize Waves to keep the listed payment method on file and use it for future agreed service payments until I revoke authorization.'
                    : 'I have reviewed the document terms and agree to sign this document electronically.'}
                </AgreementRow>

                {error && (
                  <div style={{ margin: '14px 0', color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 12, fontSize: 14 }}>
                    {error}
                  </div>
                )}

                <BrandButton type="submit" disabled={!canSubmit} fullWidth style={{ marginTop: 16 }}>
                  {submitting ? 'Signing...' : `Sign ${isAutopay ? 'Authorization' : 'Document'}`}
                </BrandButton>
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45, textAlign: 'center' }}>
                  Need help before signing? <HelpPhoneLink tone="dark" inline />
                </div>
              </form>
            )}
          </BrandCard>
        </div>
      </div>
    </WavesShell>
  );
}
