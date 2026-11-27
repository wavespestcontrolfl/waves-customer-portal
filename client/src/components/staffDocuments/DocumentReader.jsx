import { useEffect, useState } from 'react';
import { FieldDocumentBody, FieldFooter, FieldMasthead, FieldTitle } from '../FieldDocument';
import { etDatetimeLocalValue } from '../../lib/timezone';
import DocumentRecord from './DocumentRecord';
import { box, row, D, inputStyle, primaryStyle, buttonStyle, Field, request, dateLabel, reviewLabel, signedNameValid, downloadPdfBlob } from './common';
import './document-reader.css';

function ClauseNav({ sections }) {
  const nav = (
    <nav aria-label="Document clauses" style={{ ...row, marginTop: sections.length > 8 ? 10 : 20 }}>
      {sections.map(section => (
        <a key={section.id} href={`#${section.id}`} style={{ color: D.accent, textDecoration: 'underline', textDecorationColor: D.gold, textUnderlineOffset: 2, padding: '6px 0' }}>
          {section.number}. {section.title}
        </a>
      ))}
    </nav>
  );
  if (sections.length <= 8) return nav;
  return <details className="staff-clause-toc"><summary>Jump to section ({sections.length} sections)</summary>{nav}</details>;
}

function IssueVersionForm({ version, effective, setEffective, issueAccepted, setIssueAccepted, previewReady, busy, unresolvedCount, onRefresh, onIssue }) {
  return (
    <form onSubmit={event => { event.preventDefault(); if (previewReady) onIssue(); }} style={{ ...box, background: D.bg }}>
      <h2 style={{ fontSize: 20, marginTop: 0, color: D.accent }}>Issue this version</h2>
      <Field label="Effective date and time (Eastern)"><input type="datetime-local" required disabled={busy} style={inputStyle} value={effective} onChange={e => { setIssueAccepted(false); setEffective(e.target.value); }} /></Field>
      <button type="button" style={{ ...buttonStyle, marginBottom: 16 }} disabled={busy} onClick={onRefresh}>Refresh wording</button>
      <label style={{ ...row, marginBottom: 16 }}><input type="checkbox" required disabled={!previewReady || busy} checked={issueAccepted} onChange={e => setIssueAccepted(e.target.checked)} />I reviewed the wording, authority, owner, citations and next-review date.</label>
      <button type="submit" disabled={busy || !previewReady || !issueAccepted || unresolvedCount > 0} style={primaryStyle}>Issue version {version.version_number}</button>
    </form>
  );
}

function PolicyAcknowledgmentSection({ version, rendered, ownAck, canRecord, manage, acknowledgments, busy, name, setName, accepted, setAccepted, onSign, onDownload }) {
  const nameReady = signedNameValid(name);
  return (
    <section style={{ ...box, marginTop: 24, borderLeft: `4px solid ${ownAck ? D.successText : D.gold}` }}>
      <h2 style={{ fontSize: 20, marginTop: 0, color: D.accent }}>Your acknowledgment</h2>
      {ownAck ? (
        <div style={{ padding: 14, background: D.successBg, border: `1px solid ${D.successBorder}`, borderRadius: 8, color: D.successText }}>
          <p style={{ marginTop: 0, fontWeight: 600 }}>Signed by {ownAck.signed_name} on {dateLabel(ownAck.acknowledged_at)}.</p>
          <button disabled={busy} style={buttonStyle} onClick={() => onDownload(ownAck)}>Export signed acknowledgment</button>
        </div>
      ) : canRecord ? (
        <form onSubmit={event => { event.preventDefault(); onSign(); }}>
          <p>{rendered.acknowledgment_statement}</p>
          <Field label="Type your full name (first and last)"><input required maxLength={180} autoComplete="name" placeholder="First and last name" style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></Field>
          {name.trim() && !nameReady && <p style={{ color: '#991B1B', fontSize: 14, marginTop: -8 }}>Enter both your first and last name to sign.</p>}
          <label style={{ ...row, marginBottom: 16 }}><input type="checkbox" required checked={accepted} onChange={e => setAccepted(e.target.checked)} style={{ width: 20, height: 20, accentColor: D.accent }} />I acknowledge version {version.version_number} shown above.</label>
          <button type="submit" disabled={busy || !accepted || !nameReady} style={{ ...primaryStyle, opacity: busy || !accepted || !nameReady ? 0.6 : 1 }}>Sign acknowledgment</button>
        </form>
      ) : (
        <p>You have no acknowledgment recorded for this version.</p>
      )}
      {manage && acknowledgments.length > 0 && (
        <details>
          <summary style={{ paddingTop: 16, cursor: 'pointer', color: D.accent, fontWeight: 600 }}>All acknowledgments ({acknowledgments.length})</summary>
          {acknowledgments.map(ack => (
            <p key={ack.id}>
              {ack.technician_name ? `${ack.technician_name} (signed "${ack.signed_name}")` : ack.signed_name} · {dateLabel(ack.acknowledged_at)}{' '}
              <button disabled={busy} style={buttonStyle} onClick={() => onDownload(ack)}>Signed PDF</button>
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

function RenderedSections({ document, rendered }) {
  return rendered.sections.map(section => {
    const content = (
      <div className="staff-document-reader-prose">
        <div dangerouslySetInnerHTML={{ __html: section.html }} />
        {rendered.metadata.citations.filter(citation => citation.anchor === section.id).map(citation => (
          <p className="staff-document-reader-citation" key={`${citation.url}-${citation.anchor}`}>
            <a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.label}</a><br />
            Verified {citation.verified_on.slice(0, 10)} · Review {citation.review_on.slice(0, 10)}
          </p>
        ))}
      </div>
    );
    return document.staff_kind === 'procedure'
      ? <details id={section.id} key={section.id} className="staff-document-reader-section"><summary className="field-section-heading">{section.number}. {section.title}</summary>{content}</details>
      : <section id={section.id} key={section.id} className="staff-document-reader-section"><h2 className="field-section-heading">{section.number}. {section.title}</h2>{content}</section>;
  });
}

function ReaderChrome({ document, version, versions, versionIdentity, rendered, error, manage, busy, needsPreview, previewReady, previewError, onVersion, onEdit, onRequired, onDownload }) {
  return (
    <section className="staff-document-reader-chrome waves-field-no-print" style={{ ...box, borderLeft: `4px solid ${D.blue}` }}>
      <div style={{ ...row, justifyContent: 'space-between' }}><span style={{ textTransform: 'capitalize', color: D.accent, fontWeight: 600 }}>{document.staff_kind} · {versionIdentity.status}</span><button disabled={busy || (needsPreview && !previewReady)} style={buttonStyle} onClick={onDownload}>Export PDF</button></div>
      <div className="staff-document-reader-version"><Field label="Version history"><select style={inputStyle} value={version.id} onChange={e => onVersion(e.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>v{item.number} · {item.issued ? dateLabel(item.effective_at) : 'Draft'}</option>)}</select></Field></div>
      {version.content_hash && <details><summary style={{ cursor: 'pointer', padding: '10px 0', color: D.accent, fontWeight: 600 }}>Version identity</summary><p style={{ overflowWrap: 'anywhere', fontSize: 14 }}>SHA-256: {version.content_hash}</p><p>Version ID: {version.id}</p></details>}
      {rendered.unresolved.length > 0 && <div style={{ padding: 16, background: D.warm, borderLeft: `4px solid ${D.gold}`, borderRadius: 6 }}><strong style={{ color: D.accent }}>Decisions needed before issuance</strong><ul>{rendered.unresolved.map(value => <li key={value} style={{ overflowWrap: 'anywhere', marginTop: 6 }}>{value}</li>)}</ul></div>}
      {error && <p role="alert" style={{ padding: '10px 12px', background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 6 }}>{error}</p>}
      {manage && <div style={{ ...row, margin: '18px 0' }}><button style={buttonStyle} disabled={busy} onClick={onEdit}>Create revision</button>
        <label style={row}><input type="checkbox" disabled={busy} checked={document.onboarding_required === true} onChange={e => onRequired(e.target.checked)} />Required at onboarding</label></div>}
      {needsPreview && <p role="status">{previewError || (previewReady ? 'Wording for the selected effective date is shown below.' : 'Loading wording for the selected effective date…')}</p>}
      <ClauseNav sections={rendered.sections} />
    </section>
  );
}

export default function DocumentReader({ detail, people, selfId, manage, onVersion, onEdit, onSaved }) {
  const { document, version, versions, acknowledgments } = detail;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [effective, setEffective] = useState(etDatetimeLocalValue(new Date(Date.now() + 5 * 60000)));
  const [issueAccepted, setIssueAccepted] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [refreshPreview, setRefreshPreview] = useState(0);
  const needsPreview = manage && !version.content_hash;
  const previewReady = preview?.effective === effective && preview?.refresh === refreshPreview;
  const rendered = needsPreview && previewReady ? preview.rendered : detail.rendered;
  const canRecord = Boolean(version.content_hash && detail.current_version_id === version.id);
  const ownAck = acknowledgments.find(item => item.technician_id === selfId);
  const versionIdentity = version.content_hash
    ? { status: 'Issued', hash: `SHA-256: ${version.content_hash}` }
    : { status: 'Draft — not issued', hash: 'Draft — no issued hash' };

  useEffect(() => {
    if (!needsPreview) return undefined;
    const controller = new AbortController();
    setIssueAccepted(false); setPreview(null); setPreviewError('');
    request(`/${document.id}/preview`, { version_id: version.id, effective_at: effective }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setPreview({ ...result, effective, refresh: refreshPreview }); })
      .catch(failure => { if (!controller.signal.aborted) setPreviewError(failure.message); });
    return () => controller.abort();
  }, [document.id, version.id, needsPreview, effective, refreshPreview]);

  useEffect(() => {
    const reveal = () => {
      const element = globalThis.document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      if (element?.tagName === 'DETAILS') element.open = true;
      element?.scrollIntoView({ block: 'start' });
    };
    reveal(); window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [version.id]);

  async function act(fn) {
    setBusy(true); setError('');
    try { await fn(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  // The checkbox is controlled: read its new value before the request, not after.
  const setRequired = required => act(async () => { await request(`/${document.id}/onboarding-required`, { required }); onSaved(required ? 'Required at onboarding.' : 'No longer required at onboarding.'); });
  async function download(ack = null) {
    const query = new URLSearchParams({ version: version.id });
    if (ack) query.set('acknowledgment', ack.id);
    if (needsPreview) { query.set('effective_at', effective); query.set('preview_hash', preview.preview_hash); }
    const blob = await request(`/${document.id}/pdf?${query}`);
    const shortAck = ack?.id ? `-${String(ack.id).replace(/[^a-z0-9-]+/gi, '').slice(0, 8)}` : '';
    await downloadPdfBlob(blob, `${document.template_key}-v${version.version_number}${ack ? `-acknowledged${shortAck}` : ''}.pdf`);
  }

  return <article className="staff-document-reader">
    <ReaderChrome
      document={document} version={version} versions={versions} versionIdentity={versionIdentity}
      rendered={rendered} error={error} manage={manage} busy={busy} needsPreview={needsPreview}
      previewReady={previewReady} previewError={previewError}
      onVersion={onVersion} onEdit={onEdit} onRequired={setRequired} onDownload={() => act(() => download())}
    />
    <FieldDocumentBody className="staff-document-reader-body">
      <FieldMasthead variant="staff" />
      <FieldTitle
        eyebrow={`${document.staff_kind} · v${version.version_number} · ${versionIdentity.status}`}
        title={rendered.title}
        subtitle={`Owner role: ${rendered.metadata.owner_role || 'Unassigned'} · Next review: ${reviewLabel(rendered.metadata.review_on)}`}
        reference={`Effective: ${dateLabel(version.effective_at)} (Eastern)`}
      />
      <RenderedSections document={document} rendered={rendered} />
      <FieldFooter label={versionIdentity.hash} />
    </FieldDocumentBody>
    <div className="staff-document-reader-actions waves-field-no-print">
      {needsPreview && (
        <IssueVersionForm
          version={version} effective={effective} setEffective={setEffective}
          issueAccepted={issueAccepted} setIssueAccepted={setIssueAccepted}
          previewReady={previewReady} busy={busy} unresolvedCount={rendered.unresolved.length}
          onRefresh={() => { setIssueAccepted(false); setRefreshPreview(value => value + 1); }}
          onIssue={() => act(async () => { await request(`/${document.id}/issue`, { version_id: version.id, effective_at: effective, preview_hash: preview.preview_hash }); onSaved('Document issued.'); })}
        />
      )}
      {version.content_hash && !canRecord && <div style={{ ...box, marginTop: 24 }}><p>This version is read-only. New acknowledgments and records use the version currently in force.</p>{detail.current_version_id && <button style={buttonStyle} onClick={() => onVersion(detail.current_version_id)}>Open current version</button>}</div>}
      {version.content_hash && document.staff_kind === 'policy' && (
        <PolicyAcknowledgmentSection
          version={version} rendered={rendered} ownAck={ownAck} canRecord={canRecord} manage={manage}
          acknowledgments={acknowledgments} busy={busy} name={name} setName={setName} accepted={accepted} setAccepted={setAccepted}
          onSign={() => act(async () => { await request(`/versions/${version.id}/acknowledge`, { content_hash: version.content_hash, signed_name: name.trim(), accepted }); onSaved('Your acknowledgment was saved for this version.'); })}
          onDownload={ack => act(() => download(ack))}
        />
      )}
      {version.content_hash && document.staff_kind !== 'policy' && <DocumentRecord key={version.id} detail={detail} people={people} selfId={selfId} manage={manage} canWrite={canRecord} onSaved={onSaved} />}
    </div>
  </article>;
}
