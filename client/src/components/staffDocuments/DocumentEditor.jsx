import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import { box, row, inputStyle, buttonStyle, primaryStyle, Field, request } from './common';

export default function DocumentEditor({ initial, onSaved, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [citations, setCitations] = useState(JSON.stringify(initial.source.metadata.citations, null, 2));
  const [fields, setFields] = useState(JSON.stringify(initial.source.metadata.fields, null, 2));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState([]);
  useEffect(() => {
    if (initial.id) return undefined;
    const controller = new AbortController();
    adminFetch('/admin/timetracking/documents?technicianId=company', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unable to load historical attachments.');
      const payload = await response.json(); setAttachments(payload.documents);
    }).catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); });
    return () => controller.abort();
  }, [initial.id]);
  const changeSource = values => setDraft(previous => ({ ...previous, source: { ...previous.source, ...values } }));
  const changeMetadata = values => changeSource({ metadata: { ...draft.source.metadata, ...values } });
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const source = { ...draft.source, metadata: { ...draft.source.metadata, citations: JSON.parse(citations), fields: JSON.parse(fields) } };
      const result = await request('/drafts', { ...draft, source });
      onSaved(result.document.id, result.version.id);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} style={box}>
    <h2 style={{ fontSize: 20, marginTop: 0 }}>{draft.id ? 'Create a revision' : 'New controlled document'}</h2>
    <p>Saving creates a draft. Issued copies remain available in version history.</p>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      {!draft.id && <>
        <Field label="Document key"><input required style={inputStyle} value={draft.key} onChange={e => setDraft({ ...draft, key: e.target.value })} /></Field>
        <div style={row}>
          <Field label="Document type"><select style={inputStyle} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}><option value="policy">Policy · signed acknowledgment</option><option value="procedure">Procedure · checklist</option><option value="form">Form · records</option></select></Field>
          <Field label="Who can read it"><select style={inputStyle} value={draft.access} onChange={e => setDraft({ ...draft, access: e.target.value })}><option value="staff">All staff</option><option value="admin">Admins</option></select></Field>
        </div>
        <Field label="Historical company attachment (optional)"><select style={inputStyle} value={draft.legacy_company_document_id || ''} onChange={e => setDraft({ ...draft, legacy_company_document_id: e.target.value || null })}><option value="">No linked attachment</option>{attachments.map(attachment => <option key={attachment.id} value={attachment.id}>{attachment.title}</option>)}</select></Field>
      </>}
      <Field label="Title"><input required style={inputStyle} value={draft.source.title} onChange={e => changeSource({ title: e.target.value })} /></Field>
      <div style={row}>
        <Field label="Document owner role"><input style={inputStyle} maxLength={120} value={draft.source.metadata.owner_role || ''} placeholder="Office Manager" onChange={e => changeMetadata({ owner_role: e.target.value || null })} /></Field>
        <Field label="Next review"><input type="date" style={inputStyle} value={draft.source.metadata.review_on?.slice(0, 10) || ''} onChange={e => changeMetadata({ review_on: e.target.value || null })} /></Field>
      </div>
      <p>Use a job title for ownership. Keep current staff and backup assignments in the coverage register. Signatures and case assignments identify the person who acted.</p>
      <Field label="Document source"><textarea required rows={22} style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }} value={draft.source.body} onChange={e => changeSource({ body: e.target.value })} /></Field>
      <p>Start each clause with <code>## Title {'{#stable-anchor}'}</code>. Use paragraphs, bullet lists, emphasis and HTTPS links. Keep anchor IDs when wording changes. Shared terms use bindings such as <code>{'{{policy.pto_accrual}}'}</code>.</p>
      <details><summary style={{ cursor: 'pointer', padding: '12px 0' }}>Clause citations</summary>
        <p>Each citation binds an anchor to a label, HTTPS URL, verified_on date and review_on date. Regulatory citations require a review within 90 days.</p>
        <Field label="Citations (JSON)"><textarea style={{ ...inputStyle, fontFamily: 'monospace' }} rows={8} value={citations} onChange={e => setCitations(e.target.value)} /></Field>
      </details>
      {(draft.kind === 'form' || initial.kind === 'form') && <details><summary style={{ cursor: 'pointer', padding: '12px 0' }}>Record fields</summary>
        <p>Define each field with id, label, type (text, textarea, date or checkbox) and required (true or false).</p>
        <Field label="Fields (JSON)"><textarea style={{ ...inputStyle, fontFamily: 'monospace' }} rows={10} value={fields} onChange={e => setFields(e.target.value)} /></Field>
      </details>}
      <div style={row}><button style={primaryStyle} type="submit">{busy ? 'Saving…' : 'Save draft revision'}</button><button style={buttonStyle} type="button" onClick={onClose}>Cancel</button></div>
    </fieldset>
  </form>;
}
