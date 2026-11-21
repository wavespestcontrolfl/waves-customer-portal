/**
 * The first-days checklist of a hire, on the offer card: the items the owner
 * marks done after the offer is signed. The server sends each item's label and
 * due line (job-offers.js firstDaysOf). Only the owner account gets the
 * buttons; another admin reads the list.
 */
import React from "react";
import { Button } from "../../ui";
import { formatTimelineTime } from "./offerLogic";

const doneLine = (item) => `Done ${formatTimelineTime(item.doneAt)}${item.doneByName ? ` by ${item.doneByName}` : ""}`;

export default function OfferFirstDays({ firstDays, busy, canAct, onSet }) {
  if (!firstDays?.items?.length) return null;
  return (
    <div className="border-hairline border border-zinc-200 rounded p-3 mb-3" data-testid="offer-first-days">
      <div className="text-14 font-medium text-zinc-900 mb-2">First days checklist</div>
      <ul className="flex flex-col gap-3">
        {firstDays.items.map((item) => (
          <li key={item.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0">
              <div className="text-14 text-zinc-800 break-words">{item.label}</div>
              <div className="text-14 text-zinc-500">{item.doneAt ? doneLine(item) : item.due}</div>
            </div>
            {canAct && (
              <Button
                size="sm"
                variant={item.doneAt ? "ghost" : "secondary"}
                className="sm:ml-auto sm:shrink-0"
                onClick={() => onSet(item.key, !item.doneAt)}
                disabled={busy}
                aria-label={`${item.doneAt ? "Undo" : "Mark done"}: ${item.label}`}
              >
                {item.doneAt ? "Undo" : "Mark done"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
