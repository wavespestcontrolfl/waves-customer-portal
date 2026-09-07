import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DocumentEditor from './DocumentEditor';
import DocumentReader from './DocumentReader';
import PolicyValuesEditor from './PolicyValuesEditor';
import { box, row, D, inputStyle, buttonStyle, primaryStyle, Field, request, reviewLabel } from './common';

const emptyDraft = () => ({ key: '', kind: 'procedure', access: 'staff', source: { title: '', body: '## Purpose {#purpose}\nWrite the procedure here.', metadata: { owner_role: null, review_on: null, citations: [], fields: [] } } });

export default function StaffDocumentLibrary({ manage = false }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('document'); const selectedVersion = params.get('version');
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [profile, setProfile] = useState(null);
  const [starters, setStarters] = useState([]);
  const [search, setSearch] = useState('');
  const [at, setAt] = useState('');
  const [kind, setKind] = useState('all');
  const [editing, setEditing] = useState(null);
  const [policyEditor, setPolicyEditor] = useState(false);
  const [errors, setErrors] = useState({});
  const setRequestError = (scope, message) => setErrors(previous => ({ ...previous, [scope]: message }));
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const canManage = manage && profile?.can_manage;

  useEffect(() => {
    const controller = new AbortController();
    request('/people', undefined, controller.signal).then(result => { setProfile(result); setRequestError('profile', ''); }).catch(failure => { if (failure.name !== 'AbortError') setRequestError('profile', failure.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!canManage) return undefined;
    const controller = new AbortController();
    request('/starters', undefined, controller.signal).then(result => { setStarters(result.starters); setRequestError('starters', ''); }).catch(failure => { if (failure.name !== 'AbortError') setRequestError('starters', failure.message); });
    return () => controller.abort();
  }, [canManage]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ search }); if (at) query.set('at', at);
      request(`/?${query}`, undefined, controller.signal).then(result => { setItems(result.documents); setRequestError('list', ''); }).catch(failure => { if (failure.name !== 'AbortError') setRequestError('list', failure.message); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, at, reload]);
  useEffect(() => {
    setDetail(current => current?.document.id === selected && (!selectedVersion || current.version.id === selectedVersion) ? current : null);
    if (!selected) return undefined;
    const controller = new AbortController();
    const query = new URLSearchParams(); if (selectedVersion) query.set('version', selectedVersion); if (at) query.set('at', at);
    request(`/${selected}?${query}`, undefined, controller.signal).then(result => { setDetail(result); setRequestError('detail', ''); }).catch(failure => { if (failure.name !== 'AbortError') setRequestError('detail', failure.message); });
    return () => controller.abort();
  }, [selected, selectedVersion, at, reload]);
  function select(id, version) {
    const next = new URLSearchParams(params);
    if (id) next.set('document', id); else next.delete('document');
    if (version) next.set('version', version); else next.delete('version');
    setParams(next); setEditing(null); setPolicyEditor(false); setRequestError('detail', '');
  }
  function saved(text) { setMessage(text); setReload(value => value + 1); }
  function editCurrent() {
    setEditing({ id: detail.document.id, base_version_id: detail.versions[0].id, kind: detail.document.staff_kind,
      source: { title: detail.version.title, body: detail.version.body, metadata: detail.version.staff_metadata } });
  }
  return <div style={{ color: D.text, fontSize: 14, fontFamily: 'Inter, sans-serif', lineHeight: 1.6, display: 'grid', gap: 18, minWidth: 0 }} data-testid="staff-document-library">
    <section style={box}>
      <div style={{ ...row, justifyContent: 'space-between' }}><div><h2 style={{ fontSize: 24, margin: 0 }}>Controlled documents</h2><p style={{ marginBottom: 0 }}>Policies, working procedures and accountable records.</p></div>{canManage && <div style={row}><button style={buttonStyle} onClick={() => { setPolicyEditor(true); setEditing(null); }}>Shared policy values</button><button style={primaryStyle} onClick={() => { setEditing(emptyDraft()); setPolicyEditor(false); }}>New document</button></div>}</div>
      {message && <p role="status">{message}</p>}{Object.entries(errors).filter(([, message]) => message).map(([scope, message]) => <p role="alert" key={scope}>{message}</p>)}
      {canManage && <Field label="Start from a reviewed draft"><select style={{ ...inputStyle, marginTop: 8 }} value="" onChange={e => { const starter = starters.find(item => item.key === e.target.value); if (starter) { setEditing(structuredClone(starter)); setPolicyEditor(false); } }}><option value="">Choose a draft…</option>{starters.map(starter => <option key={starter.key} value={starter.key}>{starter.source.title}</option>)}</select></Field>}
    </section>
    {editing ? <DocumentEditor key={`${editing.id || editing.key}-${editing.base_version_id || 'new'}`} initial={editing} onClose={() => setEditing(null)} onSaved={(id, version) => { select(id, version); saved('Draft revision saved.'); }} /> : policyEditor ? <PolicyValuesEditor onClose={() => setPolicyEditor(false)} onSaved={text => { setPolicyEditor(false); saved(text); }} /> : <>
      {selected ? <>
        <button style={{ ...buttonStyle, justifySelf: 'start' }} onClick={() => select(null)}>← All controlled documents</button>
        {errors.detail || errors.profile ? null : !detail || !profile ? <p>Loading document…</p> : <DocumentReader key={detail.version.id} detail={detail} people={profile.people} selfId={profile.self_id} manage={canManage} onVersion={id => select(selected, id)} onEdit={editCurrent} onSaved={saved} />}
      </> : <>
        <div style={{ ...box, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 16 }}>
          <Field label="Search document wording"><input type="search" style={inputStyle} value={search} onChange={e => setSearch(e.target.value)} placeholder="PTO, vehicle release, complaints…" /></Field>
          <Field label="Document type"><select style={inputStyle} value={kind} onChange={e => setKind(e.target.value)}><option value="all">All types</option><option value="policy">Policies</option><option value="procedure">Procedures / SOPs</option><option value="form">Forms / records</option></select></Field>
          <Field label="In force at (Eastern, optional)"><input type="datetime-local" style={inputStyle} value={at} onChange={e => setAt(e.target.value)} /></Field>
        </div>
        {errors.list ? null : !items ? <p>Loading documents…</p> : <div style={{ display: 'grid', gap: 12 }}>
          {!items.filter(item => kind === 'all' || item.staff_kind === kind).length && <p style={box}>{canManage ? 'No matching documents. Start a reviewed draft or create a document above.' : 'No issued documents are available for this view.'}</p>}
          {items.filter(item => kind === 'all' || item.staff_kind === kind).map(item => <button key={item.id} style={{ ...box, cursor: 'pointer', textAlign: 'left', width: '100%', color: D.text, fontSize: 14 }} onClick={() => select(item.id, item.version_id)}><div style={{ ...row, justifyContent: 'space-between' }}><strong style={{ fontSize: 18 }}>{item.title}</strong><span style={{ textTransform: 'capitalize' }}>{item.staff_kind} · v{item.version_number} · {item.issued ? 'Issued' : 'Draft'}</span></div><div style={{ marginTop: 8 }}>Owner role: {item.owner_role || 'Unassigned'} · Review: {reviewLabel(item.review_on)}</div></button>)}
        </div>}
      </>}
    </>}
  </div>;
}
