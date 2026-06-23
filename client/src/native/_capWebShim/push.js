// DEV-ONLY web shim for @capacitor/push-notifications (CAP_SHIM=1). Native-only at runtime.
export const PushNotifications = {
  requestPermissions: async () => ({ receive: 'denied' }),
  register: async () => {},
  addListener: async () => ({ remove() {} }),
  removeAllListeners: async () => {},
  checkPermissions: async () => ({ receive: 'denied' }),
};
export default { PushNotifications };
