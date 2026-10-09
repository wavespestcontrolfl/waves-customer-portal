// The lawn sheet's one soft prompt for a blade-and-crown close-up (GATE_LAWN_TREATMENT_GUIDE).
// Advisory only: it never blocks Analyze or Complete. The tag it names, "Blade and crown"
// (`blade_crown` in shared/lawn-photo-shots.json), only exists while the shot list is live.
import React, { useEffect, useRef, useState } from "react";
import { Button } from "../ui";

export const CLOSE_UP_PROMPT = "Add one close-up of the blades and crown at the edge of the damaged spot so the insect check can read it.";
export const BLADE_CROWN = "blade_crown";

/**
 * Whether the prompt shows now: a photo is tagged Problem area, none is tagged Blade and crown, and no
 * analysis has run. It is spent for the visit once it was open and then closed for any reason (a Blade
 * and crown photo, an analysis, a Dismiss, or the Problem area photo removed or retagged), so neither a
 * retake nor a second Problem area tag brings it back.
 */
export function useCloseUpPrompt({ enabled, shotList, photos, hasResult }) {
  const [done, setDone] = useState(false);
  const wasOpen = useRef(false);
  const trouble = photos.some((photo) => photo.zone === "trouble");
  const bladeCrown = photos.some((photo) => photo.zone === "blade_crown");
  const open = !!enabled && !!shotList && !done && trouble && !bladeCrown && !hasResult;
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) setDone(true);
  }, [open]);
  return { open, dismiss: () => setDone(true) };
}

// The slot buttons' own disabled rule, for the Blade and crown shot.
export const closeUpBlocked = ({ disabled, analyzing, photos, photoCap, readingShots, isFull }) => (
  !!disabled || analyzing || photos.length >= photoCap || isFull(photos, BLADE_CROWN) || readingShots.includes(BLADE_CROWN)
);

// "Add close-up" opens the same photo picker the slot buttons use, with the shot set to Blade and
// crown (the block's onAdd), so the photo arrives already tagged and the prompt closes by itself.
export default function CloseUpPrompt({ open, onAdd, addDisabled, onDismiss, buttonClassName }) {
  if (!open) return null;
  return (
    <div role="status" data-testid="lawn-close-up-prompt" className="flex items-start justify-between gap-2 text-14 text-zinc-500">
      <span>{CLOSE_UP_PROMPT}</span>
      <span className="flex shrink-0 gap-2">
        <Button variant="secondary" className={buttonClassName} disabled={addDisabled} onClick={onAdd}>Add close-up</Button>
        <Button variant="secondary" className={buttonClassName} onClick={onDismiss}>Dismiss</Button>
      </span>
    </div>
  );
}
