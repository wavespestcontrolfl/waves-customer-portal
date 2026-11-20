import { createContext, useContext, useEffect } from "react";

// A dialog open over the applicant detail hides its replies. RecruitingPage counts every such dialog through this
// context (the stage dialog, the offer form, and the card's signed copy and withdraw or discard question), so a read
// of the applicant on screen marks replies read only while none is open.
export const DetailCover = createContext(null);

// Counts one dialog over the detail while `open` is true.
export function useCoverWhile(open) {
  const cover = useContext(DetailCover);
  useEffect(() => {
    if (!open || !cover) return undefined;
    cover(1);
    return () => cover(-1);
  }, [open, cover]);
}
