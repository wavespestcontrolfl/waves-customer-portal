import { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';
import { isNativeApp, nativePushConnectionState, requestNativePushPermission } from '../native/nativePush';

// One readiness read at the settings-page boundary, shared by every row.
export default function useAppNotifications(available, customerId) {
  const [status, setStatus] = useState(null);
  const [deviceState, setDeviceState] = useState('checking');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!available) return undefined;
    let current = true;
    setStatus(null);
    setDeviceState('checking');
    (async () => {
      const nextDevice = isNativeApp() ? await nativePushConnectionState() : 'web';
      const nextStatus = await api.getCustomerPushStatus().catch(() => null);
      if (!current) return;
      setStatus(nextStatus);
      setDeviceState(nextDevice);
    })().catch(() => { if (current) setDeviceState('registration_unavailable'); });
    return () => { current = false; };
  }, [available, customerId, attempt]);

  useEffect(() => {
    if (!available) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [available, refresh]);

  const enable = async () => {
    setBusy(true);
    const result = await requestNativePushPermission();
    setDeviceState(result);
    setBusy(false);
    if (result === 'granted') refresh();
  };
  return { status, deviceState, busy, refresh, enable, ready: status?.enabled === true && status?.fresh === true && ['web', 'granted'].includes(deviceState) };
}
