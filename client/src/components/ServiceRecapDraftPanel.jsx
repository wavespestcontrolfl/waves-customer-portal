import React from 'react';
import { Button, ActionFeedback } from './ui';

// Draft recovery notices for the recap modal. Kept outside ServiceRecapModal
// so the candidate / storage / missing-product states do not add branching
// to that component.
export function RecapDraftPanel({ draft, onRestore }) {
  return (
    <>
      {draft.candidate && (
        <div className="tech-visit-card">
          <ActionFeedback className="tech-visit-feedback">A saved draft is available for this visit.</ActionFeedback>
          {draft.restoreError && <ActionFeedback error className="tech-visit-feedback">{draft.restoreError}</ActionFeedback>}
          <div className="tech-visit-actions">
            <Button className="tech-visit-action tech-visit-primary" disabled={!!draft.restoreError} onClick={onRestore}>Restore draft</Button>
            <Button variant="secondary" className="tech-visit-action" onClick={draft.discard}>Discard draft</Button>
          </div>
        </div>
      )}
      {draft.saved && <ActionFeedback className="tech-visit-feedback">Draft saved on this device. Not submitted.</ActionFeedback>}
      {draft.storageError && <ActionFeedback error className="tech-visit-feedback">{draft.storageError}</ActionFeedback>}
    </>
  );
}

export function RecapMissingSelections({ ids, names, onRemove }) {
  return ids.map((id) => {
    const label = names[id] || id;
    return (
      <div key={id} className="tech-visit-card">
        <ActionFeedback error className="tech-visit-feedback">Unavailable product from draft: {label}. Review the actual treatment before completing.</ActionFeedback>
        <Button variant="secondary" className="tech-visit-action" onClick={() => onRemove(id)}>Remove {label}</Button>
      </div>
    );
  });
}
