import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';

function ProcedureText({ procedure, D, full = false }) {
  return <>
    <p style={{ color: D.muted, margin: '0 0 4px' }}>{procedure.source}</p>
    <h3 style={{ fontSize: 18, fontWeight: 500, margin: '0 0 12px' }}>{procedure.name}</h3>
    <p>{procedure.title}</p>
    {procedure.objective && <p style={{ padding: 12, background: D.bg }}>{procedure.objective}</p>}
    {procedure.visitNotes.map((note, i) => <p key={i} style={{ padding: 12, background: D.bg }}>{note}</p>)}
    <ol style={{ paddingLeft: 24 }}>
      {procedure.steps.map((step, i) => <li key={i} style={{ padding: '8px 0 8px 4px' }}>{step}</li>)}
    </ol>
    {procedure.conditional.length > 0 && <>
      <h4 style={{ fontSize: 14, fontWeight: 500 }}>If needed</h4>
      <ul style={{ paddingLeft: 24 }}>{procedure.conditional.map((step, i) => <li key={i} style={{ marginBottom: 8 }}>{step}</li>)}</ul>
    </>}
    {full && procedure.notes.length > 0 && <>
      <h4 style={{ fontSize: 14, fontWeight: 500 }}>Protocol notes</h4>
      {procedure.notes.map((note, i) => <p key={i}>{note}</p>)}
    </>}
  </>;
}

function SopSheet({ procedure, onClose, D }) {
  const panelRef = useModalFocus(true, onClose);
  useLockBodyScroll();
  function download() {
    const content = [procedure.name, procedure.source, procedure.title, procedure.objective, ...procedure.visitNotes,
      'Steps', ...procedure.steps.map((step, i) => `${i + 1}. ${step}`),
      ...(procedure.conditional.length ? ['If needed', ...procedure.conditional] : []),
      ...procedure.notes,
      'Check the Job Card for current product weather clearance and verified mixing amounts.',
    ].filter(Boolean).join('\n\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'waves-service-procedure.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(24,24,27,0.35)' }}>
    <section ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Service SOP"
      style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: '100%', maxWidth: 600, background: D.card, color: D.heading, display: 'flex', flexDirection: 'column', outline: 'none', boxSizing: 'border-box', fontSize: 14, lineHeight: 1.6 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'calc(16px + env(safe-area-inset-top, 0px)) 20px 16px', borderBottom: `1px solid ${D.border}` }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Service SOP</h2>
        <button type="button" onClick={onClose} style={{ minHeight: 44, padding: '8px 12px', border: `1px solid ${D.border}`, background: D.card, color: D.heading }}>Close</button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, overflowWrap: 'anywhere' }}>
        <p style={{ color: D.muted }}>Check the Job Card for current product weather clearance and verified mixing amounts.</p>
        <ProcedureText procedure={procedure} D={D} full />
      </div>
      <footer style={{ padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${D.border}` }}>
        <button type="button" onClick={download} style={{ minHeight: 44, padding: '8px 12px', border: `1px solid ${D.border}`, background: D.card, color: D.heading }}>Download text</button>
      </footer>
    </section>
  </div>, document.body);
}

export default function VisitProtocol({ card, D, onJobCard }) {
  const [sheet, setSheet] = useState(null);
  const lines = [{ name: card.strip?.program || 'Booked service', procedure: card.protocol.procedure, note: card.lineNote }, ...card.protocol.addons];
  return <div style={{ fontSize: 14, lineHeight: 1.6, color: D.heading, overflowWrap: 'anywhere' }}>
    <button type="button" onClick={onJobCard} style={{ minHeight: 44, padding: '8px 12px', border: `1px solid ${D.border}`, background: D.card, color: D.heading }}>View product checks and mixing amounts</button>
    {card.planBlocks.length > 0 && <div role="alert" style={{ color: D.red, padding: '12px 0' }}>
      <p>Resolve the Job Card blocks before application.</p>
      {card.planBlocks.map((block, i) => <p key={i}>{block.message}</p>)}
    </div>}
    {lines.map((line, i) => <section key={i} style={{ borderBottom: `1px solid ${D.border}`, padding: '20px 0' }}>
      <p style={{ color: D.muted }}>{line.name}</p>
      {line.procedure ? <>
        <ProcedureText procedure={line.procedure} D={D} />
        <button type="button" onClick={() => setSheet(line.procedure)} style={{ minHeight: 44, padding: '8px 16px', background: D.heading, color: D.white, border: `1px solid ${D.heading}` }}>Read SOP</button>
      </> : <p>{line.note || 'No published procedure is available for this booked service.'}</p>}
    </section>)}
    {sheet && <SopSheet procedure={sheet} D={D} onClose={() => setSheet(null)} />}
  </div>;
}
