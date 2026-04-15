import React, { useEffect, useMemo, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

/**
 * JobFormSection
 *
 * Loads the active template for a service type and renders its sections.
 * Controlled: parent owns `value` (responses) and `onChange`.
 *
 * Props:
 *   serviceType  — string, e.g. 'pest_quarterly'
 *   value        — { [fieldId]: any }
 *   onChange     — (nextResponses) => void
 *   onReady      — (template) => void        (optional, fires once template loads)
 *   dark         — boolean, use dark palette (default true, matches DispatchPage)
 */
export default function JobFormSection({ serviceType, value, onChange, onReady, dark = true }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const P = dark
    ? { bg: '#1e293b', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', accent: '#0ea5e9', input: '#0f1923' }
    : { bg: '#fff', border: '#cbd5e1', text: '#0f172a', muted: '#64748b', accent: '#0A7EC2', input: '#f8fafc' };

  useEffect(() => {
    let cancel = false;
    if (!serviceType) { setLoading(false); return; }
    setLoading(true);
    adminFetch(`/admin/job-forms/templates/by-service/${encodeURIComponent(serviceType)}`)
      .then(r => r.json())
      .then(data => {
        if (cancel) return;
        if (data?.template) {
          const sections = typeof data.template.sections === 'string'
            ? JSON.parse(data.template.sections) : data.template.sections;
          setTemplate({ ...data.template, sections });
          if (onReady) onReady(data.template);
        } else {
          setTemplate(null);
        }
      })
      .catch(e => { if (!cancel) setError(e.message); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [serviceType]); // eslint-disable-line react-hooks/exhaustive-deps

  const { totalRequired, filledRequired } = useMemo(() => {
    if (!template?.sections) return { totalRequired: 0, filledRequired: 0 };
    let total = 0, filled = 0;
    for (const s of template.sections) {
      for (const f of (s.fields || [])) {
        if (!f.required) continue;
        total++;
        const v = value?.[f.id];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        filled++;
      }
    }
    return { totalRequired: total, filledRequired: filled };
  }, [template, value]);

  function setField(fieldId, v) {
    onChange({ ...(value || {}), [fieldId]: v });
  }

  if (loading) return <div style={{ fontSize: 13, color: P.muted, padding: '8px 0' }}>Loading checklist…</div>;
  if (error) return <div style={{ fontSize: 13, color: '#ef4444' }}>Checklist error: {error}</div>;
  if (!template) return null;

  const pct = totalRequired ? Math.round((filledRequired / totalRequired) * 100) : 100;

  return (
    <div style={{ marginTop: 8, marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 13, fontWeight: 700, color: P.text, marginBottom: 8,
      }}>
        <span>{template.name}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: pct === 100 ? '#10b981' : P.muted }}>
          {filledRequired}/{totalRequired} required · {pct}%
        </span>
      </div>

      {template.sections.map((section, si) => (
        <div key={si} style={{
          background: P.bg, border: `1px solid ${P.border}`, borderRadius: 10,
          padding: 12, marginBottom: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: P.text, marginBottom: 8 }}>{section.title}</div>
          {(section.fields || []).map(f => (
            <Field key={f.id} field={f} value={value?.[f.id]} onChange={v => setField(f.id, v)} P={P} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Field({ field, value, onChange, P }) {
  const label = (
    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: P.text, marginBottom: 4 }}>
      {field.label}{field.required ? <span style={{ color: '#ef4444' }}> *</span> : null}
    </label>
  );

  const inputStyle = {
    width: '100%', background: P.input, color: P.text, border: `1px solid ${P.border}`,
    borderRadius: 8, padding: '8px 10px', fontSize: 13, boxSizing: 'border-box',
    fontFamily: 'inherit',
  };

  if (field.type === 'checkbox') {
    return (
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: P.text, fontSize: 13 }}>
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
          <span>{field.label}{field.required ? <span style={{ color: '#ef4444' }}> *</span> : null}</span>
        </label>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div style={{ marginBottom: 10 }}>
        {label}
        <select value={value || ''} onChange={e => onChange(e.target.value)} style={inputStyle}>
          <option value="">— choose —</option>
          {(field.options || []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'multi_select') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div style={{ marginBottom: 10 }}>
        {label}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(field.options || []).map(opt => {
            const active = arr.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange(active ? arr.filter(x => x !== opt) : [...arr, opt])}
                style={{
                  padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: active ? P.accent : P.input,
                  color: active ? '#fff' : P.text,
                  border: `1px solid ${active ? P.accent : P.border}`,
                }}
              >{opt}</button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div style={{ marginBottom: 10 }}>
        {label}
        <input type="number" step="any" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} style={inputStyle} />
      </div>
    );
  }

  // default: text / textarea
  const isLong = field.type === 'textarea' || field.long;
  return (
    <div style={{ marginBottom: 10 }}>
      {label}
      {isLong ? (
        <textarea value={value || ''} onChange={e => onChange(e.target.value)} rows={3}
          style={{ ...inputStyle, resize: 'vertical' }} />
      ) : (
        <input type="text" value={value || ''} onChange={e => onChange(e.target.value)} style={inputStyle} />
      )}
    </div>
  );
}
