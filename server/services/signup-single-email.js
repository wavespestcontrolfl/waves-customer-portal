/**
 * ONE SIGNUP EMAIL — the accept route's hold-and-fall-back orchestration
 * (GATE_SIGNUP_SINGLE_EMAIL, dark; owner-approved 2026-09-29).
 *
 * At a standard recurring signup three emails used to go out separately:
 * "You're booked" (estimate.accepted_onboarding), "Your Waves membership is
 * active" (membership.started) and "Auto Pay is set up" (the Auto Pay
 * confirmation, fired from enrollment). With the gate on, the first one also
 * carries the plan and the stored Auto Pay authorization (see
 * estimate-accepted-email.js), and this lane holds the other two until it is
 * known whether that email was accepted for sending AND actually rendered the
 * section they would have delivered:
 *
 *   membership.started      → sent unless the plan section was delivered
 *   Auto Pay confirmation   → sent unless the payment section was delivered
 *
 * Anything else — no email on file, suppressed, blocked, failed, a missing or
 * older template, a throw, the gate turned off mid-flight — sends each held
 * email exactly as it would have without the gate, so nothing is lost. Each
 * held email fires at most once. Enrollment itself is never held, only the
 * copy of its confirmation.
 *
 * The Auto Pay confirmation is normally released by the onboarding send; a
 * timer (armed once enrollment has returned) releases it on its own if the
 * accept throws before that point (a held authorization copy must never be
 * lost to an exception — worst case the customer sees it twice).
 */

const featureGates = require('../config/feature-gates');
const logger = require('./logger');

const GUARD_MS = 3 * 60 * 1000;

// Read at call time. Defensive on the reader itself so a caller whose test
// double of feature-gates predates it just reads as gate off.
function signupGateLive() {
  return typeof featureGates.signupSingleEmailLive === 'function' && featureGates.signupSingleEmailLive();
}

// Gate on, a standard recurring signup (one that sends a membership email
// today — annual prepay does not and stays out), and a customer to send to.
function signupLaneEligible({ annualPrepaySelected = false, customerId = null, standardConversion = null } = {}) {
  return signupGateLive()
    && !annualPrepaySelected
    && !!customerId
    && !!standardConversion?.membershipEmail
    && standardConversion?.recurringConversionSkipped !== true;
}

// What the DELIVERED combined email covered. A send that was not accepted
// (no address, suppressed, failed) covers nothing.
function coverageOf(result) {
  if (!result?.sent || !result.signup) return {};
  return { planCovered: result.signup.planCovered === true, paymentCovered: result.signup.paymentCovered === true };
}

function createSignupEmailLane({
  eligible = false,
  customerId = null,
  membershipEmail = null,
  // () => the accept's enrollment result ({ sendEnrollmentConfirmation,
  // confirmationMethodRowId, paymentMethodRowId } when a fresh enrollment held
  // its confirmation); read lazily because enrollment runs after this is built.
  getEnrollment = () => null,
  sendMembershipStarted = (args) => require('./account-membership-email').sendMembershipStarted(args),
  guardMs = GUARD_MS,
} = {}) {
  let membershipSettled = false;
  let autopaySettled = false;
  let timer = null;

  const settleMembership = ({ send }) => {
    if (membershipSettled) return;
    membershipSettled = true;
    if (!send) return;
    Promise.resolve()
      .then(() => sendMembershipStarted(membershipEmail))
      .catch((e) => logger.error(`[estimate-accept] membership.started email failed for customer ${customerId}: ${e.message}`));
  };
  const settleAutopay = ({ send }) => {
    if (autopaySettled) return;
    autopaySettled = true;
    if (timer) clearTimeout(timer);
    if (!send) return;
    try { getEnrollment()?.sendEnrollmentConfirmation?.(); } catch { /* best-effort, as at enrollment */ }
  };
  // Armed by the route AFTER enrollment has returned (armGuard), never before:
  // a timer started earlier could settle while enrollment was still running
  // and no closure existed yet, and the confirmation it later returned could
  // then never be sent.
  const armGuard = () => {
    if (!eligible || timer || autopaySettled) return;
    timer = setTimeout(() => settleAutopay({ send: true }), guardMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  // Release whatever is still held, minus what the combined email covered.
  const settle = (coverage = {}) => {
    if (!eligible) return;
    settleMembership({ send: coverage.planCovered !== true });
    settleAutopay({ send: coverage.paymentCovered !== true });
  };

  return {
    eligible: !!eligible,
    // Passed to the enrollment call: hand back the confirmation closure
    // instead of firing it.
    holdEnrollmentConfirmation: !!eligible,
    armGuard,
    settle,
    // Send the combined email via `sendOnboarding(signup)` (which resolves the
    // sendEstimateAcceptedOnboarding result), then settle from what it really
    // delivered. Never throws; a throw settles as "nothing covered".
    async run(sendOnboarding) {
      if (!eligible) return;
      let coverage = {};
      try {
        const enrollment = getEnrollment();
        const result = await sendOnboarding({
          membershipEmail,
          // Only a fresh enrollment whose own confirmation would have gone out
          // (the enrolled method IS the one in charge) has an authorization
          // to fold in.
          paymentMethodRowId: typeof enrollment?.sendEnrollmentConfirmation === 'function'
            ? (enrollment.confirmationMethodRowId || enrollment.paymentMethodRowId || null)
            : null,
        });
        coverage = coverageOf(result);
      } catch (e) {
        logger.error(`[estimate-accept] onboarding email failed for customer ${customerId}: ${e.message}`);
      }
      settle(coverage);
    },
  };
}

module.exports = { createSignupEmailLane, signupLaneEligible, coverageOf, signupGateLive, GUARD_MS };
