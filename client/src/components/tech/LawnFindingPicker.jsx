import { useState } from 'react';
import library from '../../../../shared/lawn-condition-findings.json';
const { groups, locations, extents } = library;
const quickLabels = ['Sedge — unidentified', 'Dollarweed', 'Gray leaf spot — suspected', 'Moisture stress', 'Improved color', 'Reduced weeds'];

const input = { width: '100%', minHeight: 44, padding: '8px 10px', fontSize: 14, color: '#0f172a', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' };

export default function LawnFindingPicker({ disabled, onAdd }) {
  const [query, setQuery] = useState('');
  const [statement, setStatement] = useState('');
  const [location, setLocation] = useState('');
  const [extent, setExtent] = useState('');
  const [added, setAdded] = useState(false);
  const filtered = groups.map((group) => ({ ...group, findings: group.findings.filter((finding) => `${group.label} ${finding.label}`.toLowerCase().includes(query.toLowerCase())) }));
  const text = [statement, location && `Location: ${location}.`, extent && `Extent: ${extent}.`].filter(Boolean).join(' ');
  return (
    <details style={{ margin: '12px 0', padding: 14, border: '1px solid #d4d4d4', borderRadius: 12 }}>
      <summary style={{ fontSize: 14, cursor: 'pointer', minHeight: 28 }}>Add an issue or improvement</summary>
    <fieldset disabled={disabled} style={{ padding: 14, margin: '16px 0', border: '1px solid #cbd5e1', borderRadius: 12, minWidth: 0 }}>
      <legend style={{ fontSize: 14, fontWeight: 500 }}>Lawn findings</legend>
      <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.4, margin: '0 0 12px' }}>Select only what you observed or checked today.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {quickLabels.map((label) => <button key={label} type="button" style={{ ...input, width: 'auto' }} onClick={() => { setStatement(groups.flatMap((group) => group.findings).find((finding) => finding.label === label).statement); setAdded(false); }}>{label}</button>)}
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 14 }}>Search conditions
        <input style={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Sedge, leaf spot, irrigation…" />
      </label>
      <label style={{ display: 'grid', gap: 6, marginTop: 10, fontSize: 14 }}>Finding
        <select aria-label="Finding" style={input} value={statement} onChange={(event) => { setStatement(event.target.value); setAdded(false); }}>
          <option value="">Choose a finding…</option>
          {statement && !filtered.some((group) => group.findings.some((finding) => finding.statement === statement)) && <option value={statement}>{statement}</option>}
          {filtered.filter((group) => group.findings.length).map((group) => <optgroup key={group.label} label={group.label}>
            {group.findings.map((finding) => <option key={finding.label} value={finding.statement}>{finding.label}</option>)}
          </optgroup>)}
        </select>
      </label>
      <label style={{ display: 'grid', gap: 6, marginTop: 10, fontSize: 14 }}>Location
        <select aria-label="Location" style={input} value={location} onChange={(event) => setLocation(event.target.value)}>
          <option value="">Choose inspected area…</option>
          {locations.map((area) => <option key={area}>{area}</option>)}
        </select>
      </label>
      <label style={{ display: 'grid', gap: 6, marginTop: 10, fontSize: 14 }}>Extent (optional)
        <select aria-label="Extent (optional)" style={input} value={extent} onChange={(event) => setExtent(event.target.value)}>
          <option value="">Not recorded</option>
          {extents.map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
      {statement && <p style={{ fontSize: 14, lineHeight: 1.5 }}>{text}</p>}
      <button type="button" disabled={!statement || !location || text.length > 240 || disabled} onClick={() => { onAdd(text); setStatement(''); setAdded(true); }} style={{ ...input, marginTop: 12, cursor: 'pointer' }}>Add finding to report</button>
      {added && <div role="status" style={{ fontSize: 14, marginTop: 8 }}>Finding added. Record any work performed under Protocol actions and Products applied.</div>}
    </fieldset>
    </details>
  );
}
