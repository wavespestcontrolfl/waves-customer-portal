// Misting layout designer (GATE_MISTING_LAYOUT_DESIGNER). Staff screen only.
//
// Opens over the property's Google satellite photo (the Treatment Zone Mapper's
// loader and px-to-feet math). Staff draw eave lines and fence lines; nozzles are
// placed live (a corner nozzle at each vertex but a short jog, then about every 10 ft) by
// lib/mistingLayoutGeometry. Staff can delete a nozzle (Edit nozzles: tap it), move it (drag)
// and add one (Add nozzle: tap a line). Step 2 adds three tools that do not use the lines: Riser
// (tap adds, tap on a riser deletes, drag moves), Pump (one point) and No-mist zone (a circle the
// mist must avoid; nozzles and risers inside one are flagged). "Use counts" hands the nozzle total
// back to the estimator's Nozzles input, and the riser total to its Risers input when there are
// risers. Step 3: "Save layout" composes the branded sketch PNG and saves it with the geometry on the
// estimate (needs a saved estimate); reopening the designer on that estimate restores the saved layout.
//
// The look is glass: the photo fills the frame and the title, tools, counts, legend and controls float on
// frosted panels (misting-designer/MistingLayoutGlass). Every nozzle carries a spray direction (lib/mistingLayoutAim):
// an arrow on the map and, with Spray on, animated mist along it (misting-designer/MistingSprayLayer). In Edit
// nozzles, dragging an arrow tip aims that nozzle by hand and Reset aim puts it back.
//
// The pieces live in ./misting-designer: useMistingMapImage (photo), useMistingLayoutState (lines,
// edits, notice), useMistingLayoutExtras (risers, pump, zones, flags), useMistingLayoutPointer (taps
// and drags per tool), useSavedMistingLayout / useMistingLayoutSave (step 3) and MistingLayoutParts /
// MistingLayoutGraphics / MistingLayoutSaveBar (display).
import { useMemo, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui';
import { restoreLayout, savedLayoutIsForOtherAddress } from '../../lib/mistingLayoutPersist';
import useMistingMapImage from './misting-designer/useMistingMapImage';
import useSavedMistingLayout from './misting-designer/useSavedMistingLayout';
import useMistingLayoutSave from './misting-designer/useMistingLayoutSave';
import MistingLayoutSaveBar from './misting-designer/MistingLayoutSaveBar';
import useMistingLayoutState, { editCount } from './misting-designer/useMistingLayoutState';
import useMistingLayoutPointer from './misting-designer/useMistingLayoutPointer';
import {
  CONCEPT_LABEL,
  ControlPanel,
  CountsPanel,
  EditsClearedNotice,
  ExtrasClearedNotice,
  MapCanvas,
  ToolHint,
  ToolPalette,
  limitNote,
  riserLimitNote,
} from './misting-designer/MistingLayoutParts';
import { GlassLegend, GlassStage, GlassTitle } from './misting-designer/MistingLayoutGlass';

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

function DesignerBody({ address, lat, lng, limits, estimateId, saved, replacesOther, onUseCounts, onClose }) {
  // A saved layout reopens on the photo it was drawn on (its center and zoom), so its pixels land on the same ground.
  const preset = saved ? { center: saved.center, zoom: saved.zoom } : null;
  const mapState = useMistingMapImage(address, lat, lng, preset);
  const initial = useMemo(() => (saved ? restoreLayout(saved) : null), [saved]);
  const layout = useMistingLayoutState(mapState, initial);
  const { frameRef, handlers } = useMistingLayoutPointer(layout, mapState);
  const { ready, totals, notice } = layout;
  const [panelsShown, setPanelsShown] = useState(true); // Panels off clears the glass off the photo, to trace under it
  const save = useMistingLayoutSave({ estimateId, mapState, address: address || (saved && saved.address) || null, layout, saved });

  const useCounts = () => {
    if (totals.count <= 0) return;
    // Second argument: the riser count, which the estimator writes only when it is above zero.
    onUseCounts?.(totals.count, { risers: layout.risers.length });
    onClose?.();
  };

  return (
    <DesignerFrame address={address || (saved && saved.address)} onClose={onClose}>
      <DialogBody>
        <LoadState mapState={mapState} />
        {ready && (
          <>
            {replacesOther && (
              <p role="status" data-testid="layout-other-address" className="text-14 text-amber-800 mb-3">
                A layout saved for a different address is not shown. Saving this one replaces it.
              </p>
            )}
            <GlassStage
              frame={(
                <MapCanvas
                  frameRef={frameRef}
                  handlers={handlers}
                  layout={layout}
                  mapUrl={mapState.url}
                  address={address}
                  map={{ lat: mapState.center.lat, zoom: mapState.zoom }}
                />
              )}
              topLeft={panelsShown ? (
                <>
                  <GlassTitle title="Proposed misting layout" note={CONCEPT_LABEL} />
                  <ToolPalette layout={layout} />
                </>
              ) : null}
              topRight={panelsShown ? (
                <>
                  <CountsPanel layout={layout} note={limitNote(totals.count, limits)} riserNote={riserLimitNote(layout.risers.length, limits)} />
                  <GlassLegend />
                </>
              ) : null}
              bottomLeft={(
                <ControlPanel
                  layout={layout}
                  editsPresent={editCount(layout.edits) > 0}
                  panelsShown={panelsShown}
                  onTogglePanels={() => setPanelsShown((shown) => !shown)}
                />
              )}
            />
            <ToolHint layout={layout} />
            {notice && <EditsClearedNotice notice={notice} onRestore={layout.restoreSnapshot} onDismiss={layout.dismissNotice} />}
            {layout.clearedExtras && (
              <ExtrasClearedNotice
                notice={layout.clearedExtras}
                onRestore={layout.restoreExtras}
                onDismiss={layout.dismissClearedExtras}
              />
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {ready && <MistingLayoutSaveBar save={save} />}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {ready && (
          <Button onClick={useCounts} disabled={totals.count <= 0}>
            Use counts
          </Button>
        )}
      </DialogFooter>
    </DesignerFrame>
  );
}

function DesignerFrame({ address, onClose, children }) {
  return (
    <Dialog open onClose={onClose} size="lg" className="lg:max-w-5xl" aria-label="Misting layout designer">
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
      {children}
    </Dialog>
  );
}

// `estimateId` is the saved estimate's id, or null for an estimate that is not saved yet (then there is nothing to
// reopen and Save layout asks for the estimate to be saved first).
export default function MistingLayoutDesigner({ address, lat, lng, limits, estimateId = null, onUseCounts, onClose }) {
  const savedState = useSavedMistingLayout(estimateId);
  if (savedState.status !== 'ready') {
    return (
      <DesignerFrame address={address} onClose={onClose}>
        <DialogBody>
          {savedState.status === 'loading'
            ? <p role="status" className="text-14 text-zinc-600 text-center py-10">Loading saved layout…</p>
            : (
              <div role="alert" className="px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900">
                {savedState.message} Close the designer and open it again.
              </div>
            )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DesignerFrame>
    );
  }
  // A layout drawn for another address is never reopened for this one (its pixels are on the old property's photo).
  const otherAddress = savedLayoutIsForOtherAddress(savedState.saved, address);
  return (
    <DesignerBody
      address={address}
      lat={lat}
      lng={lng}
      limits={limits}
      estimateId={estimateId}
      saved={otherAddress ? null : savedState.saved}
      replacesOther={otherAddress}
      onUseCounts={onUseCounts}
      onClose={onClose}
    />
  );
}
