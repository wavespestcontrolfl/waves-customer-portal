import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import DocumentActionBar from '../components/DocumentActionBar';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';
import { DOC, DOC_COLUMN, DOC_EYEBROW, FS, FW, LH, SP, RADIUS, docInput } from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmtDate(value) {
  if (!value) return 'Not set';
  const date = value instanceof Date ? value : new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}



function ContractError({ title, message }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div role="alert" className="waves-contract-page waves-contract-single" style={{ width: DOC_COLUMN }}>
        <BrandCard padding={28}>
          <SerifHeading style={{ marginTop: 0, marginBottom: SP.sm }}>{title}</SerifHeading>
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
  // Always reflects the active token so an in-flight sign POST can tell if the
  // page moved to a different contract before it resolved.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // BrandCard / BrandButton / WavesShell already emit their own data-glass markup.
  useGlassSurface(true);
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

  // Bearer-token page: never indexed/archived. The server X-Robots-Tag in
  // sensitive-spa-headers.js is the authoritative protection; this client
  // meta is belt-and-suspenders for the mounted view. Mount-only, and it
  // RESTORES the prior tag on unmount — the SPA never reloads, so leaving a
  // noindex tag behind would silently de-index whatever public page the
  // visitor navigates to next.
  useEffect(() => {
    const existing = document.querySelector('meta[name="robots"]');
    const priorContent = existing ? existing.getAttribute('content') : null;
    const createdTag = !existing;
    const meta = existing || document.createElement('meta');
    meta.setAttribute('name', 'robots');
    meta.setAttribute('content', 'noindex,nofollow,noarchive');
    if (createdTag) document.head.appendChild(meta);
    return () => {
      if (createdTag) meta.remove();
      else if (priorContent !== null) meta.setAttribute('content', priorContent);
      else meta.removeAttribute('content');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Every token starts CLEAN. React-router reuses this component instance
    // when only the :token param changes, so without these resets contract
    // A's typed initials, signature name, and checked agreement boxes would
    // survive into contract B's render — B could arrive pre-filled and
    // immediately submittable with A's identity.
    setContract(null);
    setError('');
    setSubmitting(false);
    setSigned(false);
    setForm({
      initials: '',
      signedName: '',
      agreeElectronic: false,
      agreeAuthorization: false,
      agreeDocumentTerms: false,
    });
    fetch(`${API_BASE}/contracts/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not load contract');
        return body.contract;
      })
      .then((next) => {
        if (cancelled) return;
        setContract(next);
        // Seed the signature field from THIS contract's own recipient —
        // never from whatever a previous token's signer typed.
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
    // Bind this submission to the token it was signed under: if the page
    // navigates to a different contract while the POST is in flight, its
    // completion must not overwrite the new contract's state with A's
    // signed row/status or A's error.
    const submittedToken = token;
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
      if (submittedToken !== tokenRef.current) return;
      if (!res.ok) throw new Error(body.error || 'Could not sign contract');
      setContract(body.contract);
      setSigned(true);
    } catch (err) {
      if (submittedToken !== tokenRef.current) return;
      setError(err.message || 'Could not sign contract');
    } finally {
      if (submittedToken === tokenRef.current) setSubmitting(false);
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
  const documentTitle = contract.title || (isAutopay ? 'AutoPay Authorization' : 'Document');
  const documentKind = isAutopay ? 'authorization' : 'document';
  // Eyebrow: the human label for the template key — never the raw
  // "service_agreement" value (owner 2026-09-03).
  const rawKind = String(contract.documentTemplateKey || contract.contractType || '').replace(/[_-]+/g, ' ').trim();
  const documentKindLabel = rawKind ? rawKind.charAt(0).toUpperCase() + rawKind.slice(1) : 'Document';
  const termsLabel = isAutopay ? 'Authorization terms' : needsSignature ? 'Document terms' : 'Document details';

  return (
    <WavesShell variant="customer" topBar="solid">
      <div className="waves-contract-page" style={{ width: DOC_COLUMN }}>
        <div className="waves-flow-header">
          <div>
            <div style={{ ...DOC_EYEBROW, marginBottom: SP.xs }}>{documentKindLabel}</div>
            <SerifHeading style={{ marginTop: 0, marginBottom: SP.xs }}>{documentTitle}</SerifHeading>
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
            {/* Stacked contact block, same as the estimate / report header
                (owner 2026-09-03): one line each, no label grid. */}
            {(() => {
              const lines = isAutopay
                ? [contract.recipientName, contract.paymentMethodLabel ? `Payment method: ${contract.paymentMethodLabel}` : null, contract.renewalDate ? `Renews ${fmtDate(contract.renewalDate)}` : null, contract.cancellationDeadline ? `Cancel by ${fmtDate(contract.cancellationDeadline)}` : null]
                : [contract.recipientName, contract.serviceName || 'Waves service', `Requested ${fmtDate(contract.sharedAt || contract.createdAt)}`];
              return (
                <div style={{ display: 'grid', gap: SP.xxs }}>
                  {lines.filter(Boolean).map((line, i) => (
                    <div key={line} style={{ fontSize: FS.bodyLg, color: i === 0 ? DOC.ink : DOC.muted, fontWeight: i === 0 ? FW.semibold : FW.regular, lineHeight: LH.body }}>{line}</div>
                  ))}
                </div>
              );
            })()}

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
                <div style={{ fontSize: FS.sub, fontWeight: FW.bold, color: DOC.ink }}>{isAutopay ? 'Authorization' : 'Document'} signed</div>
                <p style={{ margin: '8px 0 0', color: DOC.muted, fontSize: FS.body, lineHeight: LH.body }}>
                  Signed on {fmtDate(contract.signedAt)} as {contract.signedName || contract.recipientName}. Waves has recorded your electronic signature{isAutopay ? ' and authorization' : ''}.
                </p>
              </div>
            ) : !needsSignature ? (
              <div>
                <div style={{ fontSize: FS.sub, fontWeight: FW.bold, color: DOC.ink }}>No signature required</div>
                <p style={{ margin: '8px 0 0', color: DOC.muted, fontSize: FS.body, lineHeight: LH.body }}>
                  This Waves document is ready to view. You can save this link or reply to the message that sent it if you have questions.
                </p>
                <div style={{ marginTop: SP.md, fontSize: FS.body, color: DOC.muted, lineHeight: LH.snug }}>
                  Need help? <HelpPhoneLink tone="dark" inline />
                </div>
              </div>
            ) : (
              <form onSubmit={submit}>
                <div style={{ marginBottom: SP.md }}>
                  <div>
                    <div style={{ fontSize: FS.h4, fontWeight: FW.bold, color: DOC.ink }}>Sign {documentKind}</div>
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
                <div style={{ marginTop: SP.sm, fontSize: FS.body, color: DOC.muted, lineHeight: LH.snug, textAlign: 'center' }}>
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
