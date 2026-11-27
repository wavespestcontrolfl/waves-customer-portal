import { useEffect, useRef, useState } from 'react';
import { etDatetimeLocalValue } from '../../lib/timezone';
import { box, row, D, inputStyle, primaryStyle, buttonStyle, Field, request, dateLabel, signedNameValid, downloadPdfBlob } from './common';

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

function recordHeading(canWrite, kind, isSignatureForm, completed, hasValidSavedSignature) {
  if (!canWrite) return 'Historical records';
  if (kind === 'procedure') return 'Checklist mode';
  if (isSignatureForm) {
    if (hasValidSavedSignature) return 'Signed agreement';
    return completed ? 'Completed record' : 'Sign this agreement';
  }
  return 'Create a record';
}

function clearSignerAnswers(fields, rawAnswers) {
  const cleaned = { ...(rawAnswers || {}) };
  for (const field of fields) {
    if (field.type === 'checkbox') cleaned[field.id] = false;
    else if (field.id === 'signed-name' && field.type === 'text') cleaned[field.id] = '';
  }
  return cleaned;
}

function RecordFields({ fields, answers, setAnswers, assigningOther }) {
  return fields.map(field => {
    const label = `${field.label}${field.required ? ' *' : ''}`;
    if (field.type === 'checkbox') {
      return (
        <label key={field.id} style={{ ...row, marginBottom: 18, fontWeight: 500, color: D.text }}>
          <input type="checkbox" disabled={assigningOther} checked={assigningOther ? false : answers[field.id] === true} onChange={e => setAnswers({ ...answers, [field.id]: e.target.checked })} style={{ width: 20, height: 20, accentColor: D.accent }} />
          {label}
        </label>
      );
    }
    const isSig = field.id === 'signed-name' && field.type === 'text';
    const disabledForAssign = assigningOther && isSig;
    return (
      <Field key={field.id} label={label}>
        {field.type === 'textarea' ? (
          <textarea rows={4} style={inputStyle} value={answers[field.id] || ''} onChange={e => setAnswers({ ...answers, [field.id]: e.target.value })} />
        ) : (
          <input type={field.type === 'date' ? 'date' : 'text'} disabled={disabledForAssign} autoComplete={isSig ? 'name' : undefined} placeholder={disabledForAssign ? 'Filled by the assigned staff member' : isSig ? 'First and last name' : undefined} style={inputStyle} value={disabledForAssign ? '' : answers[field.id] || ''} onChange={e => setAnswers({ ...answers, [field.id]: e.target.value })} />
        )}
      </Field>
    );
  });
}

function SavedRecordsPicker({ visible, record, records, canWrite, isSignatureForm, onSelect }) {
  if (!visible) return null;
  return (
    <Field label="Saved records">
      <select style={inputStyle} value={record?.id || ''} onChange={e => onSelect(records.find(item => item.id === e.target.value) || null)}>
        <option value="">{canWrite ? (isSignatureForm ? 'New signature' : 'New record') : 'Choose historical record'}</option>
        {records.map(item => (
          <option key={item.id} value={item.id}>
            {item.completed_at ? (isSignatureForm && signedNameValid(item.answers?.['signed-name']) ? 'Signed' : 'Completed') : 'Open'}
            {item.owner_name ? ` · ${item.owner_name}` : ''} · {dateLabel(item.created_at)} · {item.id.slice(0, 8)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function RecordActions({ locked, isSignatureForm, manage, record, canSignNow, owner, selfId, onSave }) {
  if (locked) return null;
  const showDraft = !isSignatureForm || manage || Boolean(record);
  return (
    <>
      <div style={row}>
        {showDraft && (
          <button type="button" style={buttonStyle} onClick={() => onSave(false)}>
            {isSignatureForm ? 'Save draft (not signed yet)' : 'Save open record'}
          </button>
        )}
        <button type="button" disabled={!canSignNow} style={{ ...primaryStyle, opacity: canSignNow ? 1 : 0.6 }} onClick={() => onSave(true)}>
          {isSignatureForm ? 'Sign and submit agreement' : 'Complete record'}
        </button>
      </div>
      {owner !== selfId && <p>The assigned owner must complete this record.</p>}
    </>
  );
}

function RecordCompletedBanner({ record, isSignatureForm }) {
  if (!record?.completed_at) return null;
  const rawSigned = record.answers?.['signed-name'];
  const signedBy = isSignatureForm && signedNameValid(rawSigned) ? String(rawSigned).trim() : '';
  return (
    <div style={{ marginTop: 14, padding: 14, background: D.successBg, border: `1px solid ${D.successBorder}`, borderRadius: 8, color: D.successText }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {signedBy ? `Signed by ${signedBy} on ${dateLabel(record.completed_at)}.` : `Completed ${dateLabel(record.completed_at)}.`}
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 14 }}>Record {record.id}.</p>
    </div>
  );
}

function computeRecordState({ rendered, answers, owner, selfId, canWrite, record, records }) {
  const signatureField = rendered.metadata.fields.find(field => field.id === 'signed-name' && field.type === 'text' && field.required === true);
  const isSignatureForm = rendered.kind === 'form' && Boolean(signatureField);
  const signedName = String(answers['signed-name'] || '');
  const signatureReady = !isSignatureForm || signedNameValid(signedName);
  const requiredFieldsReady = rendered.metadata.fields.every(field => {
    if (!field.required) return true;
    if (field.type === 'checkbox') return answers[field.id] === true;
    if (field.id === 'signed-name' && field.type === 'text') return signedNameValid(answers[field.id]);
    return Boolean(String(answers[field.id] || '').trim());
  });
  const canSignNow = owner === selfId && (!isSignatureForm || (signatureReady && requiredFieldsReady));
  const locked = !canWrite || Boolean(record?.completed_at);
  const selectableRecords = [...new Map([...records, ...(record ? [record] : [])].map(item => [item.id, item])).values()];
  const hasValidSavedSignature = Boolean(record?.completed_at && isSignatureForm && signedNameValid(record.answers?.['signed-name']));
  const borderAccent = record?.completed_at ? D.successText : isSignatureForm ? D.gold : D.blue;
  return { isSignatureForm, signedName, signatureReady, canSignNow, locked, selectableRecords, hasValidSavedSignature, borderAccent };
}

function RecordIntro({ canWrite, isSignatureForm, locked }) {
  return (
    <>
      {!canWrite && <p>This version is historical. Open the current version to record new work.</p>}
      {isSignatureForm && !locked ? (
        <p style={{ padding: '10px 12px', background: D.bg, borderLeft: `3px solid ${D.blue}`, borderRadius: 6, color: D.text }}>
          Fill in the required details below, tick the agreement box and type your full name (first and last). Your typed name is your electronic signature under Florida Statutes 668.50.
        </p>
      ) : (
        <p style={{ color: D.muted }}>Every record keeps this version and its hash. Completed records cannot be edited.</p>
      )}
    </>
  );
}

function RecordMetaControls({ visible, assignable, owner, setOwner, due, setDue }) {
  if (!visible) return null;
  return (
    <div style={row}>
      <Field label="Record owner"><select required style={inputStyle} value={owner} onChange={e => setOwner(e.target.value)}>{assignable.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
      <Field label="Next action due (Eastern)"><input required type="datetime-local" style={inputStyle} value={due} onChange={e => setDue(e.target.value)} /></Field>
    </div>
  );
}

function ProcedureSteps({ kind, sections, steps, setSteps }) {
  if (kind !== 'procedure') return null;
  return sections.map(section => (
    <label key={section.id} style={{ display: 'flex', gap: 12, padding: '14px 0', alignItems: 'start' }}>
      <input type="checkbox" checked={steps.includes(section.id)} onChange={e => setSteps(e.target.checked ? [...steps, section.id] : steps.filter(id => id !== section.id))} style={{ marginTop: 4, width: 20, height: 20, flexShrink: 0, accentColor: D.accent }} />
      <span>{section.number}. {section.title}</span>
    </label>
  ));
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

  const state = computeRecordState({ rendered, answers, owner, selfId, canWrite, record, records });

  function selectRecord(next) {
    const isAssignedDraft = Boolean(state.isSignatureForm && next && !next.completed_at && next.created_by !== selfId);
    const loadedAnswers = isAssignedDraft ? clearSignerAnswers(rendered.metadata.fields, next.answers) : (next?.answers || {});
    setRecord(next); setAnswers(loadedAnswers); setSteps(next?.completed_steps || []);
    setOwner(next?.owner_id || selfId); setDue(etDatetimeLocalValue(next?.due_at || new Date(Date.now() + 86400000)));
  }
  async function save(complete) {
    setBusy(true); setError('');
    try {
      const outboundAnswers = state.isSignatureForm && owner !== selfId ? clearSignerAnswers(rendered.metadata.fields, answers) : answers;
      const payload = { content_hash: version.content_hash, answers: outboundAnswers, completed_steps: steps, owner_id: owner, due_at: due, complete,
        ...(record ? { id: record.id, base_updated_at: record.updated_at } : {}) };
      const result = await request(`/versions/${version.id}/records`, payload);
      selectRecord(result.record); onSaved(complete ? (state.isSignatureForm ? 'Agreement signed and saved.' : 'Completion record saved.') : 'Open record saved.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setError('');
    try {
      const blob = await request(`/${detail.document.id}/pdf?version=${version.id}&record=${record.id}`);
      const slug = detail.document.template_key || 'staff-record';
      const isSigned = Boolean(record.completed_at && state.isSignatureForm && signedNameValid(record.answers?.['signed-name']));
      const shortId = String(record.id || '').replace(/[^a-z0-9-]+/gi, '').slice(0, 8);
      await downloadPdfBlob(blob, `${slug}-v${version.version_number || 1}-${isSigned ? 'signed' : 'record'}${shortId ? `-${shortId}` : ''}.pdf`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const prefilled = usePrefill({ detail, canWrite, record, owner, setAnswers });
  const assignable = people.filter(person => (manage || person.id === selfId) && (detail.document.staff_access !== 'admin' || person.role === 'admin'));

  return <section style={{ ...box, marginTop: 24, borderLeft: `4px solid ${state.borderAccent}` }}>
    <h2 style={{ marginTop: 0, fontSize: 20, color: D.accent }}>{recordHeading(canWrite, rendered.kind, state.isSignatureForm, Boolean(record?.completed_at), state.hasValidSavedSignature)}</h2>
    <RecordIntro canWrite={canWrite} isSignatureForm={state.isSignatureForm} locked={state.locked} />
    <SavedRecordsPicker visible={manage || !state.isSignatureForm || state.selectableRecords.length > 0} record={record} records={state.selectableRecords} canWrite={canWrite} isSignatureForm={state.isSignatureForm} onSelect={selectRecord} />
    {error && <p role="alert" style={{ padding: '10px 12px', background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 6 }}>{error}</p>}
    <fieldset disabled={busy || state.locked} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <RecordMetaControls visible={manage || !state.isSignatureForm} assignable={assignable} owner={owner} setOwner={setOwner} due={due} setDue={setDue} />
      <ProcedureSteps kind={rendered.kind} sections={rendered.sections} steps={steps} setSteps={setSteps} />
      <RecordFields fields={rendered.metadata.fields} answers={answers} setAnswers={setAnswers} assigningOther={state.isSignatureForm && owner !== selfId} />
      {state.isSignatureForm && !state.locked && state.signedName.trim() && !state.signatureReady && <p style={{ color: '#991B1B', fontSize: 14, marginTop: -8 }}>Enter both your first and last name to sign.</p>}
      <PrefillNote hidden={state.locked || Boolean(record)} fields={rendered.metadata.fields} prefilled={prefilled} answers={answers} />
      <RecordActions locked={state.locked} isSignatureForm={state.isSignatureForm} manage={manage} record={record} canSignNow={state.canSignNow} owner={owner} selfId={selfId} onSave={save} />
    </fieldset>
    <RecordCompletedBanner record={record} isSignatureForm={state.isSignatureForm} />
    {record && <button disabled={busy} type="button" style={{ ...buttonStyle, marginTop: 12 }} onClick={download}>Export record PDF</button>}
  </section>;
}
