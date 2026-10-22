import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Field } from "../../../components/ui/Field";
import { Input } from "../../../components/ui/Input";
import { earliestPick, formatSendAt, schedulePresets } from "./scheduleSend";

// The arrow beside Send, as in Gmail: "Schedule send" with three preset times
// and "Pick date & time". Times are Eastern. onSchedule(sendAt) gets the
// Eastern wall-clock string; the parent queues the email.
export default function ScheduleSendMenu({ disabled, onSchedule, label = "Schedule send options" }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState("");
  const wrapRef = useRef(null);
  const close = () => { setOpen(false); setPicking(false); };

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (wrapRef.current && !wrapRef.current.contains(event.target)) close(); };
    const escape = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const choose = (sendAt) => { close(); onSchedule(sendAt); };
  const presets = open ? schedulePresets() : [];
  const min = open ? earliestPick() : "";
  return <div ref={wrapRef} className="relative">
    <Button variant="primary" disabled={disabled} aria-label={label} aria-haspopup="true" aria-expanded={open}
      onClick={() => { setOpen((value) => !value); setPicking(false); setPick(""); }} className="px-2">
      <ChevronDown size={16} aria-hidden />
    </Button>
    {open && <div role="group" aria-label="Schedule send"
      className="absolute bottom-full right-0 z-20 mb-2 w-72 rounded-md border-hairline border-zinc-200 bg-white p-2 text-ui-body">
      <p className="m-0 px-2 py-1 font-medium">Schedule send</p>
      {!picking ? <>
        {presets.map((preset) => <button key={preset.key} type="button" onClick={() => choose(preset.sendAt)}
          className="u-focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm border-0 bg-white px-2 text-left hover:bg-zinc-50">
          <span>{preset.label}</span><span className="u-nums text-ink-secondary">{formatSendAt(preset.sendAt)}</span>
        </button>)}
        <button type="button" onClick={() => { setPicking(true); setPick(min); }}
          className="u-focus-ring flex min-h-11 w-full items-center rounded-sm border-0 border-t-hairline border-zinc-200 bg-white px-2 text-left hover:bg-zinc-50">
          Pick date &amp; time
        </button>
      </> : <div className="space-y-2 p-2">
        <Field id="schedule-send-at" label="Date and time (Eastern)">
          <Input type="datetime-local" value={pick} min={min} onChange={(event) => setPick(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPicking(false)}>Back</Button>
          <Button disabled={!pick || pick < min} onClick={() => choose(pick)}>Schedule send</Button>
        </div>
      </div>}
    </div>}
  </div>;
}
