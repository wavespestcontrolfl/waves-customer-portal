// Misting layout designer (GATE_MISTING_LAYOUT_DESIGNER, step 1). Staff screen only.
//
// Opens over the property's Google satellite photo (the Treatment Zone Mapper's
// loader and px-to-feet math). Staff draw eave lines and fence lines; nozzles are
// placed live (a corner at every vertex, then about every 10 ft) by
// lib/mistingLayoutGeometry. Staff can delete a nozzle (Edit nozzles: tap it), move it (drag)
// and add one (Add nozzle: tap a line). "Use counts" hands the nozzle total back to the
// estimator's Nozzles input. Nothing is saved and there is no export in this step.
//
// The pieces live in ./misting-designer: useMistingMapImage (photo), useMistingLayoutState (lines,
// edits, notice), useMistingLayoutPointer (taps and drags per tool) and MistingLayoutParts (display).
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui';
import useMistingMapImage from './misting-designer/useMistingMapImage';
import useMistingLayoutState, { editCount } from './misting-designer/useMistingLayoutState';
import useMistingLayoutPointer from './misting-designer/useMistingLayoutPointer';
import {
  CONCEPT_LABEL,
  CountsPanel,
  EditsClearedNotice,
  MapCanvas,
  Toolbar,
  limitNote,
  toolHint,
} from './misting-designer/MistingLayoutParts';

export { CONCEPT_LABEL };

function LoadState({ mapState }) {
  if (mapState.status === 'loading') {
    return <p role="status" className="text-14 text-zinc-600 text-center py-10">Loading satellite photo…</p>;
  }
  if (mapState.status === 'error') {
    return (
      <div role="alert" className="px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900">
        {mapState.message}
      </div>
    );
  }
  return null;
}

export default function MistingLayoutDesigner({ address, lat, lng, limits, onUseCounts, onClose }) {
  const mapState = useMistingMapImage(address, lat, lng);
  const layout = useMistingLayoutState(mapState);
  const { frameRef, handlers } = useMistingLayoutPointer(layout, mapState);
  const { ready, mode, totals, notice } = layout;

  const useCounts = () => {
    if (totals.count <= 0) return;
    onUseCounts?.(totals.count);
    onClose?.();
  };

  return (
    <Dialog open onClose={onClose} size="lg" aria-label="Misting layout designer">
      <DialogHeader className="flex items-start justify-between gap-3">
        <div>
          <DialogTitle>Design misting layout</DialogTitle>
          {address ? <p className="text-14 text-zinc-600 mt-1">{address}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close layout designer"
          className="text-22 leading-none text-zinc-600 px-2 min-h-11"
        >
          ×
        </button>
      </DialogHeader>
      <DialogBody>
        <LoadState mapState={mapState} />
        {ready && (
          <>
            <Toolbar layout={layout} editsPresent={editCount(layout.edits) > 0} />
            <p className="text-14 text-zinc-600 mb-3">{toolHint(mode)}</p>
            {mode === 'add' && layout.addMiss && (
              <p role="status" className="text-14 text-amber-800 mb-3">Tap on a drawn line to add a nozzle</p>
            )}
            <MapCanvas frameRef={frameRef} handlers={handlers} layout={layout} mapUrl={mapState.url} address={address} />
            {notice && <EditsClearedNotice notice={notice} onRestore={layout.restoreSnapshot} onDismiss={layout.dismissNotice} />}
            <CountsPanel totals={totals} note={limitNote(totals.count, limits)} />
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {ready && (
          <Button onClick={useCounts} disabled={totals.count <= 0}>
            Use counts
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
