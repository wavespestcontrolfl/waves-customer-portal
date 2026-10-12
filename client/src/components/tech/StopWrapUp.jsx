// client/src/components/tech/StopWrapUp.jsx
//
// The Wrap-up of the grouped pest + lawn stop (FastCompleteComboSheet; GATE_FAST_COMPLETE_WRAP_UP and
// GATE_COMBO_FAST_COMPLETE both on, owner 2026-10-12): ONE section for the whole stop, above "Complete stop".
// Rows: one Time on-site clock, Send completion text, Send review request with its timing, and the next visit
// (shown only). No pay-link row, no time correction and no re-entry steppers: the packet sends one text for the
// stop whose pay link follows the stop's invoice, and records time and re-entry per service, so those stay on the
// full form. The parts are unchanged: each still hands over today's fixed bodies and shows no Wrap-up.
//
// The stop's choices reach the server through fields the packet already reads (see lib/fast-complete-wrap-up.js
// stopWrapUpFields): the container lays them onto BOTH item bodies at send (hooks/useComboStop.js). Untouched, it
// lays nothing, so the packet is exactly today's.
import React, { useCallback, useMemo, useState } from 'react';
import FastCompleteWrapUp, { useWrapUp } from './FastCompleteWrapUp';
import { stopWrapUpFields, wrapUpBilling } from '../../lib/fast-complete-wrap-up';

// The parts report whether their own context says the section is on; the gate is one switch, so any one saying
// yes is enough (a part shown from a saved summary after a reload has no context to ask).
function useWrapUpGates() {
  const [gates, setGates] = useState({});
  const reporters = useMemo(() => Object.fromEntries(['pest', 'lawn'].map((kind) => [kind, (on) => setGates((cur) => (cur[kind] === on ? cur : { ...cur, [kind]: on }))])), []);
  return { live: Object.values(gates).some(Boolean), reporters };
}

// The service whose billing facts the review hint reads: the first part that bills (the stop's one invoice holds the
// review until it is paid), else the pest part.
const billingServiceOf = (pest, lawn) => [pest, lawn].find((service) => wrapUpBilling(service).reviewAwaitsPayment) || pest;

// `open`: the stop is loaded, is still this pair, and has not been sent. `report(key, on)`: the container's work-in-flight
// counter, so the check holds Close, Complete stop and the parts like any other work. `fieldsRef`: read at send by
// useStopSend. `submit(send)`: the review check, then the send.
export function useStopWrapUp({ pest, lawn, request, open, report, fieldsRef }) {
  const { live, reporters } = useWrapUpGates();
  const onChecking = useCallback((busy) => report('stop-wrap-up', busy), [report]);
  const service = billingServiceOf(pest.service, lawn.service);
  const wrapUp = useWrapUp({
    gate: live && open, service, request, base: `/admin/dispatch/${pest.service.id}`,
    omitAutoTiming: true, noPayLink: true, noAdjustTime: true, noReentry: true, onChecking,
  });
  // null: not shown (the saved bodies go as saved); {}: shown at its defaults (the parts' own bodies go); else the choices.
  fieldsRef.current = () => (wrapUp.enabled ? (wrapUp.touched ? stopWrapUpFields(wrapUp.fields({})) : {}) : null);
  const submit = async (send) => {
    if (wrapUp.needsCheck() && !(await wrapUp.check())) return;
    await send.submit();
  };
  return { wrapUp, gates: reporters, since: pest.service.onSiteAt || lawn.service.onSiteAt, submit };
}

// The section, locked while the stop is busy (its review check included).
export function StopWrapUpSection({ stop, disabled }) {
  if (!stop.wrapUp.enabled) return null;
  return (
    <fieldset className="tech-visit-form" disabled={disabled}>
      <FastCompleteWrapUp wrapUp={stop.wrapUp} />
    </fieldset>
  );
}
