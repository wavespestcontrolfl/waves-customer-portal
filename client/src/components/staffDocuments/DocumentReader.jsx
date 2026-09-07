import { useEffect, useState } from 'react';
import { etDatetimeLocalValue } from '../../lib/timezone';
import DocumentRecord from './DocumentRecord';
import { box, row, D, inputStyle, primaryStyle, buttonStyle, Field, request, dateLabel, reviewLabel } from './common';

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
  async function download(ack = null) {
    const blob = await request(`/${document.id}/pdf?version=${version.id}${ack ? `&acknowledgment=${ack.id}` : ''}`);
    const url = URL.createObjectURL(blob); const link = globalThis.document.createElement('a');
    link.href = url; link.download = `${document.template_key}-v${version.version_number}${ack ? '-acknowledged' : ''}.pdf`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <article style={box}>
    <div style={{ ...row, justifyContent: 'space-between' }}><span style={{ textTransform: 'capitalize', color: D.muted }}>{document.staff_kind} · {version.content_hash ? 'Issued' : 'Draft — not issued'}</span><button disabled={busy} style={buttonStyle} onClick={() => act(() => download())}>Export PDF</button></div>
    <h1 style={{ fontSize: 26, lineHeight: 1.2, fontFamily: 'inherit', fontWeight: 700 }}>{rendered.title}</h1>
    <p>Owner role: {rendered.metadata.owner_role || 'Unassigned'} · Next review: {reviewLabel(rendered.metadata.review_on)}</p>
    <p>Effective: {dateLabel(version.effective_at)} (Eastern)</p>
    <Field label="Version history"><select style={inputStyle} value={version.id} onChange={e => onVersion(e.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>v{item.number} · {item.issued ? dateLabel(item.effective_at) : 'Draft'}</option>)}</select></Field>
    {version.content_hash && <details><summary style={{ cursor: 'pointer', padding: '10px 0' }}>Version identity</summary><p style={{ overflowWrap: 'anywhere', fontSize: 14 }}>SHA-256: {version.content_hash}</p><p>Version ID: {version.id}</p></details>}
    {rendered.unresolved.length > 0 && <div style={{ padding: 16, background: D.bg, borderRadius: 6 }}><strong>Decisions needed before issuance</strong><ul>{rendered.unresolved.map(value => <li key={value} style={{ overflowWrap: 'anywhere', marginTop: 6 }}>{value}</li>)}</ul></div>}
    {error && <p role="alert">{error}</p>}
    {manage && <div style={{ ...row, margin: '18px 0' }}><button style={buttonStyle} disabled={busy} onClick={onEdit}>Create revision</button></div>}
    {needsPreview && <p role="status">{previewError || (previewReady ? 'Wording for the selected effective date is shown below.' : 'Loading wording for the selected effective date…')}</p>}
    <nav aria-label="Document clauses" style={{ ...row, margin: '20px 0' }}>{rendered.sections.map(section => <a key={section.id} href={`#${section.id}`} style={{ color: D.text, textDecoration: 'underline', padding: '6px 0' }}>{section.number}. {section.title}</a>)}</nav>
    {rendered.sections.map(section => {
      const content = <div style={{ padding: '4px 0 16px', lineHeight: 1.7, overflowWrap: 'anywhere' }}>
        <div dangerouslySetInnerHTML={{ __html: section.html }} />
        {rendered.metadata.citations.filter(citation => citation.anchor === section.id).map(citation => <p key={`${citation.url}-${citation.anchor}`} style={{ fontSize: 14, color: D.muted }}><a href={citation.url} target="_blank" rel="noopener noreferrer" style={{ color: D.text }}>{citation.label}</a><br />Verified {citation.verified_on.slice(0, 10)} · Review {citation.review_on.slice(0, 10)}</p>)}
      </div>;
      return document.staff_kind === 'procedure'
        ? <details id={section.id} key={section.id} style={{ borderTop: `1px solid ${D.border}`, scrollMarginTop: 'calc(88px + env(safe-area-inset-top, 0px))' }}><summary style={{ padding: '18px 0', fontWeight: 700, fontSize: 18, cursor: 'pointer' }}>{section.number}. {section.title}</summary>{content}</details>
        : <section id={section.id} key={section.id} style={{ borderTop: `1px solid ${D.border}`, scrollMarginTop: 'calc(88px + env(safe-area-inset-top, 0px))' }}><h2 style={{ fontSize: 20 }}>{section.number}. {section.title}</h2>{content}</section>;
    })}
    {needsPreview && <form onSubmit={event => { event.preventDefault(); if (!previewReady) return; act(async () => { await request(`/${document.id}/issue`, { version_id: version.id, effective_at: effective, preview_hash: preview.preview_hash }); onSaved('Document issued.'); }); }} style={{ ...box, marginTop: 20, background: D.bg }}>
      <h2 style={{ fontSize: 20 }}>Issue this version</h2>
      <Field label="Effective date and time (Eastern)"><input type="datetime-local" required disabled={busy} style={inputStyle} value={effective} onChange={e => { setIssueAccepted(false); setEffective(e.target.value); }} /></Field>
      <button type="button" style={{ ...buttonStyle, marginBottom: 16 }} disabled={busy} onClick={() => { setIssueAccepted(false); setRefreshPreview(value => value + 1); }}>Refresh wording</button>
      <label style={{ ...row, marginBottom: 16 }}><input type="checkbox" required disabled={!previewReady || busy} checked={issueAccepted} onChange={e => setIssueAccepted(e.target.checked)} />I reviewed the wording, authority, owner, citations and next-review date.</label>
      <button type="submit" disabled={busy || !previewReady || !issueAccepted || rendered.unresolved.length > 0} style={primaryStyle}>Issue version {version.version_number}</button>
    </form>}
    {version.content_hash && !canRecord && <div style={{ ...box, marginTop: 24 }}><p>This version is read-only. New acknowledgments and records use the version currently in force.</p>{detail.current_version_id && <button style={buttonStyle} onClick={() => onVersion(detail.current_version_id)}>Open current version</button>}</div>}
    {version.content_hash && document.staff_kind === 'policy' && <section style={{ ...box, marginTop: 24 }}>
      <h2 style={{ fontSize: 20 }}>Your acknowledgment</h2>
      {ownAck ? <><p>Signed by {ownAck.signed_name} on {dateLabel(ownAck.acknowledged_at)}.</p><button disabled={busy} style={buttonStyle} onClick={() => act(() => download(ownAck))}>Export signed acknowledgment</button></> : canRecord ? <form onSubmit={event => { event.preventDefault(); act(async () => { await request(`/versions/${version.id}/acknowledge`, { content_hash: version.content_hash, signed_name: name, accepted }); onSaved('Your acknowledgment was saved for this version.'); }); }}>
        <p>{rendered.acknowledgment_statement}</p><Field label="Type your name"><input required maxLength={180} style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></Field>
        <label style={{ ...row, marginBottom: 16 }}><input type="checkbox" required checked={accepted} onChange={e => setAccepted(e.target.checked)} />I acknowledge version {version.version_number} shown above.</label>
        <button type="submit" disabled={busy || !accepted} style={primaryStyle}>Sign acknowledgment</button>
      </form> : <p>You have no acknowledgment recorded for this version.</p>}
      {manage && acknowledgments.length > 0 && <details><summary style={{ paddingTop: 16 }}>All acknowledgments ({acknowledgments.length})</summary>{acknowledgments.map(ack => <p key={ack.id}>{ack.signed_name} · {dateLabel(ack.acknowledged_at)} <button disabled={busy} style={buttonStyle} onClick={() => act(() => download(ack))}>Signed PDF</button></p>)}</details>}
    </section>}
    {version.content_hash && document.staff_kind !== 'policy' && <DocumentRecord key={version.id} detail={detail} people={people} selfId={selfId} manage={manage} canWrite={canRecord} onSaved={onSaved} />}
  </article>;
}
