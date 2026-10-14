// "Keep auto-dispatch off this visit" — the staff lock on one recurring
// occurrence (scheduled_services.auto_dispatch_locked), shown on both
// appointment edit forms (EditServiceModal and MobileServiceEditModal).
//
// The forms keep the checked state and send it with their one save as
// { autoDispatchLocked, autoDispatchLockedWas }; the server acts only when the
// two differ (server/services/auto-dispatch/staff-edit-lock.js) and also sets
// the lock itself when staff change the date or time. Renders nothing for a
// visit that is not a recurring occurrence: auto-dispatch never moves those.
//
// Monochrome, inline styles only, so either form's style system can host it;
// each form passes its own row container props and helper-text color.

// The value the box opens with (and the form echoes back as ...Was).
export function autoDispatchLockSeed(service) {
  return service?.autoDispatchLocked === true;
}

export default function AutoDispatchLockBox({ service, checked, onChange, disabled, rowProps, boxSize = 17, helperColor }) {
  if (!service?.isRecurring || !service?.recurringParentId) return null;
  return (
    <label {...rowProps} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', ...rowProps?.style }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{ width: boxSize, height: boxSize, marginTop: 2, accentColor: '#18181B' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Keep auto-dispatch off this visit</div>
        <div style={{ fontSize: 14, marginTop: 2, color: helperColor }}>
          Auto-dispatch will not move this visit. Changing the date or time here turns this on. A visit that a customer or staff moved to its date stays protected when this is off.
        </div>
      </div>
    </label>
  );
}
