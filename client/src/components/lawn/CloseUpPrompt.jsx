// The lawn sheet's one soft prompt for a blade-and-crown close-up (GATE_LAWN_TREATMENT_GUIDE).
// Advisory only: it never blocks Analyze or Complete. The tag it names, "Blade and crown"
// (`blade_crown` in shared/lawn-photo-shots.json), only exists while the shot list is live.
import React, { useEffect, useRef, useState } from "react";
import { Button } from "../ui";

export const CLOSE_UP_PROMPT = "Add one close-up of the blades and crown at the edge of the damaged spot and set its slot to Blade and crown, so the insect check can read it.";

/**
 * Whether the prompt shows now: a photo is tagged Problem area, none is tagged Blade and crown, and no
 * analysis has run. It is spent for the visit once it was open and then answered (a Blade and crown
 * photo, an analysis, which is what a Retake follows) or dismissed, so a retake never brings it back.
 */
export function useCloseUpPrompt({ enabled, shotList, photos, hasResult }) {
  const [done, setDone] = useState(false);
  const wasOpen = useRef(false);
  const trouble = photos.some((photo) => photo.zone === "trouble");
  const bladeCrown = photos.some((photo) => photo.zone === "blade_crown");
  const open = !!enabled && !!shotList && !done && trouble && !bladeCrown && !hasResult;
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current && (bladeCrown || hasResult)) setDone(true);
  }, [open, bladeCrown, hasResult]);
  return { open, dismiss: () => setDone(true) };
}

export default function CloseUpPrompt({ open, onDismiss, buttonClassName }) {
  if (!open) return null;
  return (
    <div role="status" data-testid="lawn-close-up-prompt" className="flex items-start justify-between gap-2 text-14 text-zinc-500">
      <span>{CLOSE_UP_PROMPT}</span>
      <Button variant="secondary" className={buttonClassName} onClick={onDismiss}>Dismiss</Button>
    </div>
  );
}
