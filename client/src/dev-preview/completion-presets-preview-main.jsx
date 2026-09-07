/**
 * Synthetic technician-closeout harness. No API or customer data is used.
 * Run the client Vite server and open /preview-completion-presets.html.
 */
import '../fonts.css';
import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ProjectFindingFieldInput from '../components/tech/ProjectFindingFieldInput';
import {
  SERVICE_COMPLETION_PRESETS,
  reconcileExclusiveProtocolSelections,
  replaceFindingGroupSelection,
} from '../lib/service-completion-presets';

const LABELS = {
  fire_ant: 'Fire ants',
  tick_control: 'Ticks',
  bee_wasp_removal: 'Bee / yellowjacket removal',
  mud_dauber_removal: 'Mud daubers',
  bed_bug_treatment: 'Bed bug heat / hybrid',
  mosquito: 'Mosquito (shared report)',
  dethatching: 'Dethatching',
  plugging: 'Lawn plugging',
};

const styles = {
  page: { maxWidth: 720, margin: '0 auto', padding: '24px 16px 64px', fontFamily: 'Inter, system-ui, sans-serif', color: '#17231d' },
  card: { background: '#fff', border: '1px solid #dce5df', borderRadius: 14, padding: 18, marginTop: 16, boxShadow: '0 6px 22px rgba(22,48,33,.06)' },
  label: { display: 'block', fontSize: 13, fontWeight: 750, margin: '16px 0 6px' },
  select: { width: '100%', minHeight: 44, border: '1px solid #b8c7bd', borderRadius: 9, padding: '0 10px', background: '#fff', fontSize: 15 },
  note: { background: '#f2f6f3', borderRadius: 9, padding: 12, marginTop: 8, whiteSpace: 'pre-wrap', minHeight: 44, fontFamily: 'ui-monospace, monospace', fontSize: 13 },
};

function Preview() {
  const [presetKey, setPresetKey] = useState('fire_ant');
  const [areas, setAreas] = useState([]);
  const [findings, setFindings] = useState([]);
  const [protocols, setProtocols] = useState([]);
  const preset = SERVICE_COMPLETION_PRESETS[presetKey];
  const taggedNotes = useMemo(() => [
    ...findings.map((value) => `[Found] ${value}`),
    ...protocols.map((value) => `[Protocol] ${value}`),
  ].join('\n'), [findings, protocols]);

  function changePreset(next) {
    setPresetKey(next);
    setAreas([]);
    setFindings([]);
    setProtocols([]);
  }

  return (
    <main style={styles.page}>
      <h1 style={{ margin: 0, fontSize: 26 }}>Technician completion preview</h1>
      <p style={{ color: '#52635a', lineHeight: 1.5 }}>Synthetic data only. This shows the real dropdown vocabulary and structured note handoff.</p>
      <section style={styles.card}>
        <label style={styles.label} htmlFor="preset">Service report</label>
        <select id="preset" value={presetKey} onChange={(event) => changePreset(event.target.value)} style={styles.select}>
          {Object.keys(LABELS).map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
        </select>

        <label style={styles.label}>Areas treated</label>
        <ProjectFindingFieldInput
          field={{ key: 'areas', label: 'Areas treated', type: 'multi_select', options: preset.areas }}
          id="preview-areas"
          name="areas"
          value={areas.join(', ')}
          onChange={(value) => setAreas(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))}
          inputStyle={{ width: '100%', boxSizing: 'border-box' }}
        />

        {preset.findingGroups.map((group) => (
          <React.Fragment key={group.key}>
            <label style={styles.label}>{group.label}</label>
            <ProjectFindingFieldInput
              field={{ ...group, type: 'select' }}
              id={`preview-${group.key}`}
              name={group.key}
              value={group.options.find((option) => findings.includes(option.value))?.value || ''}
              onChange={(value) => setFindings((current) => replaceFindingGroupSelection(current, group, value))}
              inputStyle={{ width: '100%', boxSizing: 'border-box' }}
            />
          </React.Fragment>
        ))}

        <label style={styles.label} htmlFor="protocol">Protocol actions</label>
        <select
          id="protocol"
          value=""
          onChange={(event) => {
            if (event.target.value) setProtocols((current) => reconcileExclusiveProtocolSelections(current, preset.protocols, event.target.value));
          }}
          style={styles.select}
        >
          <option value="">Add protocol action...</option>
          {preset.protocols.map((action) => <option key={action.label} value={action.label}>{protocols.includes(action.label) ? '(applied) ' : ''}{action.label}</option>)}
        </select>

        <label style={styles.label}>Technician notes handoff</label>
        <div style={styles.note}>{taggedNotes || 'Selections will appear here as [Found] and [Protocol] lines.'}</div>

        <label style={styles.label}>Structured completion snapshot</label>
        <div style={styles.note}>{JSON.stringify({ areasTreated: areas, observations: findings, actionsCompleted: protocols }, null, 2)}</div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
