import React from 'react';

// Draft recovery notices for the recap modal. Kept outside ServiceRecapModal
// so the candidate / storage / missing-product states do not add branching
// to that component.
export function RecapDraftPanel({ draft, onRestore, actionStyle, palette }) {
  return (
    <>
      {draft.candidate && (
        <div role="status" style={{ color: palette.text, marginBottom: 16 }}>
          <p>A saved draft is available for this visit.</p>
          {draft.restoreError && <p role="alert">{draft.restoreError}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button type="button" disabled={!!draft.restoreError} onClick={onRestore} style={{ ...actionStyle, opacity: draft.restoreError ? 0.5 : 1 }}>Restore draft</button>
            <button type="button" onClick={draft.discard} style={actionStyle}>Discard draft</button>
          </div>
        </div>
      )}
      {draft.saved && <p role="status" style={{ color: palette.muted }}>Draft saved on this device. Not submitted.</p>}
      {draft.storageError && <p role="alert" style={{ color: palette.red }}>{draft.storageError}</p>}
    </>
  );
}

export function RecapMissingSelections({ ids, names, onRemove, actionStyle, palette }) {
  return ids.map((id) => {
    const label = names[id] || id;
    return (
      <div key={id} role="alert" style={{ color: palette.red, marginBottom: 16 }}>
        Unavailable product from draft: {label}. Review the actual treatment before completing.
        <button type="button" onClick={() => onRemove(id)} style={actionStyle}>Remove {label}</button>
      </div>
    );
  });
}
