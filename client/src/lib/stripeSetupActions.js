export function getSetupIntentActionUrl(setupIntent) {
  const nextAction = setupIntent?.next_action;
  return nextAction?.verify_with_microdeposits?.hosted_verification_url
    || nextAction?.redirect_to_url?.url
    || '';
}

export function buildSetupIntentReturnUrl(flow) {
  const url = new URL(window.location.href);
  url.searchParams.set('stripe_setup_flow', flow);
  url.searchParams.delete('setup_intent');
  url.searchParams.delete('setup_intent_client_secret');
  url.searchParams.delete('redirect_status');
  return url.toString();
}

export function getReturnedSetupIntent(flow) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('stripe_setup_flow') !== flow) return null;
  const setupIntentId = params.get('setup_intent');
  if (!setupIntentId) return null;
  return {
    setupIntentId,
    redirectStatus: params.get('redirect_status') || '',
  };
}

export function clearReturnedSetupIntent() {
  const url = new URL(window.location.href);
  url.searchParams.delete('stripe_setup_flow');
  url.searchParams.delete('setup_intent');
  url.searchParams.delete('setup_intent_client_secret');
  url.searchParams.delete('redirect_status');
  window.history.replaceState({}, '', url.toString());
}

export function redirectToSetupIntentAction(setupIntent) {
  const actionUrl = getSetupIntentActionUrl(setupIntent);
  if (!actionUrl) return false;
  window.location.assign(actionUrl);
  return true;
}

export function setupIntentIncompleteMessage(action = 'saving') {
  return `Payment method setup is not complete yet. If you chose bank account verification, finish verification before ${action}.`;
}
