// client/src/hooks/useSavedFastCompletions.js
//
// Tech Home's view of the Fast Complete attempts saved on this device for
// the signed-in operator (useFastCompleteSubmit writes them before each
// send). It scans the device, lists the attempts, and answers a tap: open
// the sheet that made the saved attempt, block when a saved attempt cannot
// be read, or route the visit as usual. Moved out of TechHomePage so the
// page adds no decisions of its own (GitHub Codex P2 on #5979).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFastCompletionAttempt,
  hasFastCompletionMarker,
  listFastCompletionAttempts,
  listFastCompletionMarkers,
  pruneFastCompletionAttempts,
} from '../lib/completion-resume-store';

// A device read that never answers counts as unreadable after this long, so
// the Project Report tool and a tap never wait forever (GitHub Codex P2 on
// #5979).
export const DEVICE_READ_TIMEOUT_MS = 5000;
function boundedRead(read, unavailable) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(unavailable), DEVICE_READ_TIMEOUT_MS);
    Promise.resolve(read).then((result) => resolve(result), () => resolve(unavailable))
      .finally(() => clearTimeout(timer));
  });
}

export const SAVED_COMPLETION_READ_NOTICE = 'Could not read the completion saved on this device. Tap to try again.';

// A durable retry must reopen the sheet that prepared its exact body even if
// the live route now says completed. Report-flow bodies overlap the typed
// findings used by the lawn and Tree & Shrub sheets, so their frozen report
// base wins; the remaining findings type identifies the focused sheet.
export function savedCompletionKind(attempt) {
  const body = attempt?.body;
  if (!body || typeof body !== 'object') return null;
  if (Object.hasOwn(body, 'reportDraftBase')) return 'report';
  if (body.structuredFindings?.type === 'tree_shrub') return 'tree_shrub';
  if (body.structuredFindings?.type === 'one_time_lawn_treatment') return 'lawn_reservice';
  return 'pest';
}

// When a saved completion was stored on this device, for the picker, which
// otherwise shows nothing that tells two off-route attempts apart (GitHub
// Codex P2 on 102b99cb1b).
export function savedAtLabel(storedAt) {
  const when = Number(storedAt);
  if (!Number.isFinite(when) || when <= 0) return '';
  return new Date(when).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The Project Report list with this device's saved attempts: a route visit
// with one stays listed even when it reads completed or the route failed to
// load, and an attempt whose visit left today's route is listed on its own.
export function withSavedCompletions(routeServices, { saved, myServices, scheduleError, selectedVisitKey }) {
  const onRoute = routeServices.filter((service) => !scheduleError || saved.serviceIds.has(String(service.id)));
  if (selectedVisitKey) return onRoute;
  const offRoute = [...saved.attempts.values()]
    .filter((attempt) => !myServices.some((service) => String(service.id) === attempt.serviceId))
    .map((attempt) => ({
      id: attempt.serviceId, customerName: 'Saved completion',
      serviceType: attempt.summary || 'Unfinished completion', status: 'unknown',
      savedAt: attempt.storedAt, fastCompletionRecoveryOnly: true,
    }));
  return [...onRoute, ...offRoute];
}

// Tech Home's Project Report tool: it waits for the first device scan, names
// a lone saved attempt, and after a failed read says so and stays tappable
// (the tap scans again).
export function projectReportTool({ saved, projectServices, loading, onClick }) {
  const checking = loading || saved.checkPending;
  const soleSaved = projectServices.length === 1 && saved.serviceIds.has(String(projectServices[0].id));
  let label = 'Project Report';
  if (checking) label = 'Checking Saved Completions…';
  else if (soleSaved) label = 'Recover Completion';
  const description = saved.readNotice
    || (soleSaved ? 'Open the completion saved on this device' : 'Open the existing service report workflow');
  return {
    label, description, icon: 'project', onClick,
    disabled: checking || (projectServices.length === 0 && !saved.readNotice),
  };
}

// Marker-only entries for an unreadable device: enough to list and tap.
function markedAttempts(operatorId) {
  return new Map(listFastCompletionMarkers(operatorId).map((serviceId) => [serviceId, { serviceId, summary: '', storedAt: 0 }]));
}

// The scan without one service's attempt: a tap's own read found it gone.
function withoutAttempt(scan, serviceId) {
  if (!scan.attempts.has(String(serviceId))) return scan;
  const attempts = new Map(scan.attempts);
  attempts.delete(String(serviceId));
  return { ...scan, attempts };
}

// `schedule` and `openSheets` only re-trigger the scan: a route refresh or a
// sheet that opened or closed may have changed what the device holds.
export default function useSavedFastCompletions({ operatorId, schedule, openSheets = [] }) {
  const [sheetA, sheetB, sheetC] = openSheets;
  const [scan, setScan] = useState(() => ({ operatorId: null, attempts: new Map() }));
  const [readNotice, setReadNotice] = useState('');
  // Bumped by a tap while the device read failed: the tap scans again.
  const [scanTick, setScanTick] = useState(0);
  const tapSeq = useRef(0);
  const operatorRef = useRef(operatorId);
  operatorRef.current = operatorId;
  // The services this device's last scan holds a saved attempt for, as a tap
  // reads them.
  const knownIds = useRef(new Set());

  // The store's own retention only: /complete takes an overdue visit's retry
  // from its assigned technician at any age (no date cutoff;
  // completionOwnershipError), so nothing shorter may drop one (GitHub Codex
  // P2 on b1ebfd50ce).
  useEffect(() => { pruneFastCompletionAttempts().catch(() => {}); }, []);

  // Attempts remain reachable after midnight or a move removes the service
  // from today's route. Device ownership is independent of current
  // assignment; the server still verifies access and the original visit
  // before any write.
  useEffect(() => {
    let active = true;
    boundedRead(listFastCompletionAttempts(operatorId), { available: false, attempts: [] }).then((result) => {
      if (!active) return;
      // An unreadable device keeps the last list this operator had: a passing
      // storage failure must not drop saved completions. With no list yet (a
      // reload), the saved markers stand in, so a completed or off-route
      // visit is still listed to tap. When there are any, it says so and the
      // next tap scans again; a device that cannot store them at all (a
      // private window) has none to lose and stays quiet (GitHub Codex P2s on
      // 458cc517e5 and #5979).
      if (!result.available) {
        setScan((current) => (current.operatorId === operatorId ? current : { operatorId, attempts: markedAttempts(operatorId) }));
        if (knownIds.current.size || listFastCompletionMarkers(operatorId).length) setReadNotice(SAVED_COMPLETION_READ_NOTICE);
        return;
      }
      setScan({ operatorId, attempts: new Map(result.attempts.map((attempt) => [attempt.serviceId, attempt])) });
      setReadNotice((notice) => (notice === SAVED_COMPLETION_READ_NOTICE ? '' : notice));
    });
    return () => { active = false; };
  }, [schedule, operatorId, scanTick, sheetA, sheetB, sheetC]);

  // Once this operator's device has been scanned, its attempts stand while a
  // later route refresh or sheet close re-scans: keying the scan to the
  // schedule object made every refresh disable the completion buttons for a
  // moment, dropping a tap. A tap re-reads its visit's attempt anyway
  // (resolveTap), so a list a re-scan is about to replace never misroutes.
  const current = scan.operatorId === operatorId;
  const attempts = current ? scan.attempts : new Map();
  const serviceIds = new Set(attempts.keys());
  knownIds.current = serviceIds;

  // A tap on a visit: { kind } opens the sheet that made its saved attempt;
  // { route: true } routes the visit as usual; null opens nothing (a later
  // tap, another operator, or a saved attempt that cannot be read now).
  const resolveTap = useCallback(async (service) => {
    const seq = ++tapSeq.current;
    const tapOperator = operatorId;
    setReadNotice('');
    // Re-read at the tap: another tab or a just-closed sheet may have
    // discarded or completed the attempt since the picker was rendered.
    const result = tapOperator
      ? await boundedRead(getFastCompletionAttempt(service.id, tapOperator), { available: false, attempt: null })
      : { attempt: null };
    if (seq !== tapSeq.current || operatorRef.current !== tapOperator) return null;
    const kind = savedCompletionKind(result.attempt);
    if (kind) return { kind };
    const id = String(service.id);
    // A saved attempt this device knows of that cannot be read now: a fresh
    // completion here would race the saved one (its photos and report), so
    // nothing opens until it reads. "Knows of" includes the marker kept
    // outside the store, for a reload whose first scan failed too (GitHub
    // Codex P2s on 102b99cb1b, 458cc517e5 and #5979).
    if (result.available === false
      && (service.fastCompletionRecoveryOnly || knownIds.current.has(id) || hasFastCompletionMarker(id, tapOperator))) {
      setReadNotice(SAVED_COMPLETION_READ_NOTICE);
      return null;
    }
    // The tap's own read found no saved attempt for a service the list held
    // one for (another tab discarded or finished it): the stale entry leaves
    // the list before any routing (GitHub Codex P2s on 102b99cb1b and
    // b1ebfd50ce).
    if (result.available !== false && knownIds.current.has(id)) {
      setScan((latest) => withoutAttempt(latest, id));
    }
    return service.fastCompletionRecoveryOnly ? null : { route: true };
  }, [operatorId]);

  // A tap after a failed read scans the device again.
  const rescanIfUnread = useCallback(() => {
    if (readNotice) setScanTick((tick) => tick + 1);
  }, [readNotice]);

  return {
    attempts, serviceIds, readNotice, resolveTap, rescanIfUnread,
    checkPending: !!operatorId && !current,
  };
}
