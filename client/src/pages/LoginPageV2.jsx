import LoginPage from './LoginPage';

// Per product direction (2026-04-22): strip the V2 chrome — top-left Waves
// wordmark, top-right phone link, "Forgot password?" link — and revert the
// card text + CTA to V1 (yellow button, "Sign in to your account" copy).
// The simplest faithful revert is to render V1 directly. Flag + gate wiring
// stays in place so a future V2 can replace this body without touching
// LoginGate or the user_feature_flags rows.
export default function LoginPageV2() {
  return <LoginPage />;
}
