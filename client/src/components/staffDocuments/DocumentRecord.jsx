import { useEffect, useRef, useState } from 'react';
import { etDatetimeLocalValue } from '../../lib/timezone';
import { box, row, inputStyle, primaryStyle, buttonStyle, Field, request, dateLabel } from './common';

// Prefill a NEW record from the staff record (GATE_STAFF_DOC_PREFILL, flag on the detail). It fills only
// fields that are still empty, or that still hold the value the last prefill put there (owner change).
// A typed value always wins. A failed prefill is silent: the form just stays empty.
function usePrefill({ detail, canWrite, record, owner, setAnswers }) {
  const enabled = Boolean(detail.prefill && canWrite && !record); const versionId = detail.version.id;
  const [prefilled, setPrefilled] = useState({});
  const applied = useRef({});
  useEffect(() => {
    // A saved record keeps its own answers: only forget what the prefill put in.
    if (!enabled) { applied.current = {}; setPrefilled({}); return undefined; }
    // Owner or version changed on a new record: drop the last prefill's values (unless edited)
    // BEFORE asking again, so a slow or failed request never leaves another person's details here.
    const previous = applied.current;
    applied.current = {}; setPrefilled({});
    if (Object.keys(previous).length) {
      setAnswers(current => {
        const cleared = { ...current };
        for (const [id, value] of Object.entries(previous)) if (cleared[id] === value) delete cleared[id];
        return cleared;
      });
    }
    const controller = new AbortController();
    request(`/versions/${versionId}/prefill?owner_id=${encodeURIComponent(owner)}`, undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const next = result.answers || {};
      setAnswers(current => {
        const merged = { ...current };
        for (const [id, value] of Object.entries(next)) if (!current[id]) merged[id] = value;
        return merged;
      });
      applied.current = next; setPrefilled(next);
    }).catch(() => {});
    return () => controller.abort();
  }, [enabled, versionId, owner, setAnswers]);
  return prefilled;
}

function PrefillNote({ hidden, fields, prefilled, answers }) {
  if (hidden) return null;
  const labels = fields.filter(field => prefilled[field.id] && answers[field.id] === prefilled[field.id]).map(field => field.label);
  return labels.length ? <p>Filled from the staff record: {labels.join(', ')}. Check each before you save.</p> : null;
}

export default function DocumentRecord({ detail, people, selfId, manage, canWrite, onSaved }) {
  const { version, rendered, records } = detail;
  const [record, setRecord] = useState(null);
  const [answers, setAnswers] = useState({});
  const [steps, setSteps] = useState([]);
  const [owner, setOwner] = useState(selfId);
  const [due, setDue] = useState(etDatetimeLocalValue(new Date(Date.now() + 86400000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function selectRecord(next) {
    setRecord(next); setAnswers(next?.answers || {}); setSteps(next?.completed_steps || []);
    setOwner(next?.owner_id || selfId); setDue(etDatetimeLocalValue(next?.due_at || new Date(Date.now() + 86400000)));
  }
  async function save(complete) {
    setBusy(true); setError('');
    try {
      const payload = { content_hash: version.content_hash, answers, completed_steps: steps, owner_id: owner, due_at: due, complete,
        ...(record ? { id: record.id, base_updated_at: record.updated_at } : {}) };
      const result = await request(`/versions/${version.id}/records`, payload);
      selectRecord(result.record); onSaved(complete ? 'Completion record saved.' : 'Open record saved.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setError('');
    try {
      const blob = await request(`/${detail.document.id}/pdf?version=${version.id}&record=${record.id}`);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `staff-record-${record.id}.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const prefilled = usePrefill({ detail, canWrite, record, owner, setAnswers });
  const locked = !canWrite || !!record?.completed_at;
  const selectableRecords = [...new Map([...records, ...(record ? [record] : [])].map(item => [item.id, item])).values()];
  return <section style={{ ...box, marginTop: 24 }}>
    <h2 style={{ marginTop: 0, fontSize: 20 }}>{!canWrite ? 'Historical records' : rendered.kind === 'procedure' ? 'Checklist mode' : 'Create a record'}</h2>
    {!canWrite && <p>This version is historical. Open the current version to record new work.</p>}
    <p>Every record keeps this version and its hash. Completed records cannot be edited.</p>
    <Field label="Saved records"><select style={inputStyle} value={record?.id || ''} onChange={e => selectRecord(selectableRecords.find(item => item.id === e.target.value) || null)}><option value="">{canWrite ? 'New record' : 'Choose historical record'}</option>{selectableRecords.map(item => <option key={item.id} value={item.id}>{item.completed_at ? 'Completed' : 'Open'} · {dateLabel(item.created_at)} · {item.id.slice(0, 8)}</option>)}</select></Field>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy || locked} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <div style={row}>
        <Field label="Record owner"><select required style={inputStyle} value={owner} onChange={e => setOwner(e.target.value)}>{people.filter(person => (manage || person.id === selfId) && (detail.document.staff_access !== 'admin' || person.role === 'admin')).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
        <Field label="Next action due (Eastern)"><input required type="datetime-local" style={inputStyle} value={due} onChange={e => setDue(e.target.value)} /></Field>
      </div>
      {rendered.kind === 'procedure' && rendered.sections.map(section => <label key={section.id} style={{ display: 'flex', gap: 12, padding: '14px 0', alignItems: 'start' }}><input type="checkbox" checked={steps.includes(section.id)} onChange={e => setSteps(e.target.checked ? [...steps, section.id] : steps.filter(id => id !== section.id))} style={{ marginTop: 4, width: 20, height: 20, flexShrink: 0 }} /><span>{section.number}. {section.title}</span></label>)}
      {rendered.metadata.fields.map(field => {
        const label = `${field.label}${field.required ? ' *' : ''}`;
        if (field.type === 'checkbox') return <label key={field.id} style={{ ...row, marginBottom: 18 }}><input type="checkbox" checked={answers[field.id] === true} onChange={e => setAnswers({ ...answers, [field.id]: e.target.checked })} />{label}</label>;
        return <Field key={field.id} label={label}>{field.type === 'textarea' ? <textarea rows={4} style={inputStyle} value={answers[field.id] || ''} onChange={e => setAnswers({ ...answers, [field.id]: e.target.value })} /> : <input type={field.type === 'date' ? 'date' : 'text'} style={inputStyle} value={answers[field.id] || ''} onChange={e => setAnswers({ ...answers, [field.id]: e.target.value })} />}</Field>;
      })}
      <PrefillNote hidden={locked || !!record} fields={rendered.metadata.fields} prefilled={prefilled} answers={answers} />
      {!locked && <div style={row}><button type="button" style={buttonStyle} onClick={() => save(false)}>Save open record</button><button type="button" disabled={owner !== selfId} style={primaryStyle} onClick={() => save(true)}>Complete record</button></div>}
      {!locked && owner !== selfId && <p>The assigned owner must complete this record.</p>}
    </fieldset>
    {record?.completed_at && <p>Completed {dateLabel(record.completed_at)}. Record {record.id}.</p>}
    {record && <button disabled={busy} type="button" style={buttonStyle} onClick={download}>Export record PDF</button>}
  </section>;
}
