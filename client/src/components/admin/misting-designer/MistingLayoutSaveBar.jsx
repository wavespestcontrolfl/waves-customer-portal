// The Save layout button and its status line for the misting layout designer (step 3).
import { Button } from '../../ui';
import { formatETDateTime } from '../../../lib/timezone';

function statusText(save) {
  if (!save.hasEstimate) return 'Save the estimate first';
  if (!save.hasPump) return 'Place the pump first';
  if (save.saving) return 'Saving…';
  if (save.status === 'saved') {
    return `Saved ${save.savedAt ? formatETDateTime(save.savedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`.trim();
  }
  if (save.status === 'dirty') return 'Unsaved changes';
  return '';
}

export default function MistingLayoutSaveBar({ save }) {
  const text = statusText(save);
  return (
    <div className="flex flex-wrap items-center gap-3 mr-auto">
      <Button variant="secondary" onClick={save.save} disabled={!save.canSave}>
        Save layout
      </Button>
      {text ? <span aria-live="polite" data-testid="layout-save-status" className="text-14 text-zinc-600">{text}</span> : null}
      {save.error ? <span role="alert" data-testid="layout-save-error" className="text-14 text-alert-fg">{save.error}</span> : null}
    </div>
  );
}
