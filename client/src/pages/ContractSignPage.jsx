import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import DocumentActionBar from '../components/DocumentActionBar';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { DOC, DOC_COLUMN, DOC_EYEBROW, FS, FW, LH, SP, RADIUS, docInput } from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmtDate(value) {
  if (!value) return 'Not set';
  const date = value instanceof Date ? value : new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    neutral: { bg: DOC.page, color: DOC.ink, border: CUSTOMER_SURFACE.border },
    ready: { bg: 'var(--brand-soft)', color: DOC.brand, border: 'var(--brand-ring)' },
    signed: { bg: DOC.successBg, color: DOC.success, border: DOC.successBorder },
  };
  const t = tones[tone] || tones.neutral;
  // Neutral is a flat warm wash — let the glass scene through. Ready/signed
  // tones carry meaning and keep their colors.
  const glassClear = t === tones.neutral ? { 'data-glass-clear': '' } : {};
  return (
    <span {...glassClear} style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '4px 8px',
      borderRadius: RADIUS.input,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: FS.caption,
      fontWeight: FW.heavy,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ minWidth: 0, padding: '12px 0', borderBottom: `1px solid ${DOC.border}` }}>
      <div style={{ ...DOC_EYEBROW, marginBottom: SP.xxs }}>{label}</div>
      <div style={{ fontSize: FS.body, color: DOC.ink, lineHeight: LH.snug, fontWeight: FW.semibold }}>{value || 'Not set'}</div>
    </div>
  );
}

function ContractError({ title, message }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div role="alert" className="waves-contract-page waves-contract-single" style={{ width: DOC_COLUMN }}>
        <BrandCard padding={28}>
          <StatusPill>Contract unavailable</StatusPill>
          <SerifHeading style={{ marginTop: SP.md, marginBottom: SP.sm }}>{title}</SerifHeading>
          <p style={{ margin: 0, color: DOC.ink, lineHeight: LH.body }}>
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
      gap: SP.sm,
      alignItems: 'flex-start',
      padding: '12px 0',
      borderTop: `1px solid ${DOC.border}`,
      color: DOC.ink,
      fontSize: FS.body,
      lineHeight: LH.body,
      cursor: 'pointer',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, width: 16, height: 16, accentColor: DOC.brand }}
      />
      <span>{children}</span>
    </label>
  );
}

// THE document input (theme-doc names the contract signing fields as the
// reference) — minHeight 48 / 16px text (no iOS focus zoom).
const inputStyle = docInput();

export default function ContractSignPage() {
  const { token } = useParams();
  // BrandCard / BrandButton / WavesShell already emit their own data-glass markup.
  useGlassSurface(true, 'full');
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
        <div className="waves-contract-page waves-contract-single" style={{ width: DOC_COLUMN }}>
          <BrandCard padding={28}>
            <div style={{ padding: '40px 20px', textAlign: 'center', color: DOC.muted }}>Loading contract...</div>
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
      <div className="waves-contract-page" style={{ width: DOC_COLUMN }}>
        <div className="waves-flow-header">
          <div>
            <StatusPill tone={signed ? 'signed' : 'ready'}>{signedLabel}</StatusPill>
            <SerifHeading style={{ marginTop: SP.md, marginBottom: SP.xs }}>{documentTitle}</SerifHeading>
            <p style={{ margin: 0, color: DOC.muted, fontSize: FS.lead, lineHeight: LH.body, maxWidth: 660 }}>
              {isAutopay
                ? 'Review the saved-payment authorization, then sign electronically to keep AutoPay active for approved Waves services.'
                : needsSignature
                  ? 'Review this Waves document, then sign electronically to acknowledge and accept the terms shown below.'
                  : 'Review this Waves document. No signature is required.'}
            </p>
          </div>
        </div>

        {/* Unsigned render only: the customer-facing token is single-use and
            BURNED after signing (contracts-public.js returns 410), so on the
            signed-success state there is nothing valid to download OR share —
            the whole bar hides rather than offering a dead link. */}
        {!signed && (
          <DocumentActionBar
            pdfUrl={`${API_BASE}/contracts/${encodeURIComponent(token)}?format=pdf`}
            pdfFileName="Waves_Agreement.pdf"
            shareTitle="Waves service agreement"
          />
        )}

        <div className="waves-contract-grid">
          <BrandCard padding={28}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: SP.md, marginBottom: SP.lg }}>
              {/* Decorative document icon tile removed (owner 2026-07-09 —
                  no decorative icons on customer document pages). */}
              <div>
                <div style={{ fontSize: FS.sub, fontWeight: FW.heavy, color: DOC.ink }}>{documentTitle}</div>
                <div style={{ fontSize: FS.body, color: DOC.muted, marginTop: 2 }}>Waves Pest Control</div>
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

            <div style={{ marginTop: SP.xl }}>
              <div style={DOC_EYEBROW}>{termsLabel}</div>
              <div style={{
                border: `1px solid ${DOC.border}`,
                borderRadius: RADIUS.input,
                background: DOC.surface,
                padding: SP.md,
                maxHeight: 420,
                overflow: 'auto',
                whiteSpace: 'pre-line',
                fontSize: FS.body,
                lineHeight: LH.body,
                color: DOC.ink,
              }}>
                {contract.contractTextSnapshot}
              </div>
              {/* In-card Download link superseded by the DocumentActionBar
                  at the top of the page (owner 2026-07-09). */}
            </div>
          </BrandCard>

          <BrandCard padding={24} style={{ position: 'sticky', top: 20 }}>
            {signed ? (
              <div>
                <div style={{ fontSize: FS.sub, fontWeight: FW.heavy, color: DOC.ink }}>{isAutopay ? 'Authorization' : 'Document'} signed</div>
                <p style={{ margin: '8px 0 0', color: DOC.muted, fontSize: FS.body, lineHeight: LH.body }}>
                  Signed on {fmtDate(contract.signedAt)} as {contract.signedName || contract.recipientName}. Waves has recorded your electronic signature{isAutopay ? ' and authorization' : ''}.
                </p>
              </div>
            ) : !needsSignature ? (
              <div>
                <div style={{ fontSize: FS.sub, fontWeight: FW.heavy, color: DOC.ink }}>No signature required</div>
                <p style={{ margin: '8px 0 0', color: DOC.muted, fontSize: FS.body, lineHeight: LH.body }}>
                  This Waves document is ready to view. You can save this link or reply to the message that sent it if you have questions.
                </p>
                <div style={{ marginTop: SP.md, fontSize: FS.caption, color: DOC.muted, lineHeight: LH.snug }}>
                  Need help? <HelpPhoneLink tone="dark" inline />
                </div>
              </div>
            ) : (
              <form onSubmit={submit}>
                <div style={{ marginBottom: SP.md }}>
                  <div>
                    <div style={{ fontSize: FS.h4, fontWeight: FW.heavy, color: DOC.ink }}>Sign {documentKind}</div>
                    <div style={{ fontSize: FS.body, color: DOC.muted, marginTop: 2 }}>Both fields and agreements are required.</div>
                  </div>
                </div>

                <label style={{ display: 'block', marginBottom: SP.sm }}>
                  <div style={DOC_EYEBROW}>Initials</div>
                  <input
                    name="initials"
                    value={form.initials}
                    onChange={(e) => update('initials', e.target.value.toUpperCase())}
                    style={inputStyle}
                    maxLength={20}
                    autoComplete="off"
                  />
                </label>

                <label style={{ display: 'block', marginBottom: SP.md }}>
                  <div style={DOC_EYEBROW}>Typed Signature</div>
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
                  <div role="alert" style={{ margin: '16px 0', color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: RADIUS.input, padding: SP.sm, fontSize: FS.body }}>
                    {error}
                  </div>
                )}

                <BrandButton type="submit" disabled={!canSubmit} fullWidth style={{ marginTop: SP.md }}>
                  {submitting ? 'Signing...' : `Sign ${isAutopay ? 'Authorization' : 'Document'}`}
                </BrandButton>
                <div style={{ marginTop: SP.sm, fontSize: FS.caption, color: DOC.muted, lineHeight: LH.snug, textAlign: 'center' }}>
                  Need help before signing? <HelpPhoneLink tone="dark" inline />
                </div>
              </form>
            )}
          </BrandCard>
        </div>

        {/* Newsletter signup lives only on the newsletter pages (owner
            2026-07-09, supersedes same-day card ruling). */}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}
