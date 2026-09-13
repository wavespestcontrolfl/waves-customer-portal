import React, { Component, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { reportError } from './lib/reportError';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { COLORS, FONTS } from './theme-brand';
import { CUSTOMER_SURFACE } from './theme-customer';
import { useGlassSurface } from './glass/glass-engine';
import Icon from './components/Icon';
import CustomerDialogHost from './components/brand/CustomerDialogHost';

function CustomerFailureScreen({ title, message, onRetry }) {
  useGlassSurface(true);
  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: FONTS.body,
      boxSizing: 'border-box',
    }}>
      <section data-glass="modal" style={{
        width: 'min(420px, 100%)',
        position: 'relative',
        background: 'rgba(255,255,255,0.90)',
        border: `1px solid ${CUSTOMER_SURFACE.border}`,
        borderRadius: 16,
        padding: 26,
        textAlign: 'center',
        boxShadow: '0 24px 70px rgba(4,57,94,0.20)',
      }}>
        <div style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          margin: '0 auto 15px',
          background: CUSTOMER_SURFACE.soft,
          color: COLORS.glassNavy,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Icon name="warning" size={22} strokeWidth={2} />
        </div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: CUSTOMER_SURFACE.text, fontFamily: FONTS.heading }}>
          {title}
        </h1>
        <p style={{ margin: '9px 0 21px', fontSize: 14, color: CUSTOMER_SURFACE.body, lineHeight: 1.55 }}>
          {message}
        </p>
        <button
          type="button"
          data-glass-accent=""
          onClick={onRetry}
          style={{
            minHeight: 42,
            padding: '0 19px',
            background: COLORS.glassNavy,
            color: '#fff',
            border: '1px solid rgba(4,57,94,0.16)',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            fontFamily: FONTS.heading,
            cursor: 'pointer',
          }}
        >
          Try Again
        </button>
      </section>
    </main>
  );
}

class PageErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[Page crash]', error, info.componentStack);
    reportError(error, { context: 'PageErrorBoundary', componentStack: info.componentStack });
  }
  render() {
    if (this.state.error) {
      if (this.props.customerGlass) {
        return (
          <CustomerFailureScreen
            title="Something went wrong"
            message={this.state.error.message || 'This page could not be displayed. Please try again.'}
            onRetry={() => { this.setState({ error: null }); window.location.reload(); }}
          />
        );
      }
      return (
        <div style={{
          minHeight: '100vh',
          background: '#FAF8F3',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          fontFamily: FONTS.body,
          boxSizing: 'border-box',
        }}>
          <div style={{
            width: 'min(420px, 100%)',
            background: '#fff',
            border: '1px solid #E7E2D7',
            borderRadius: 8,
            padding: 24,
            textAlign: 'center',
            boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
          }}>
            <div style={{
              width: 46,
              height: 46,
              borderRadius: 8,
              margin: '0 auto 14px',
              background: `${COLORS.red}10`,
              color: COLORS.red,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Icon name="warning" size={22} strokeWidth={2} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.glassNavy, marginBottom: 8, fontFamily: FONTS.heading }}>Something went wrong</div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 1.5 }}>
            {this.state.error.message}
            </div>
            <button onClick={() => { this.setState({ error: null }); window.location.reload(); }} style={{
              minHeight: 42,
              padding: '0 18px',
              background: COLORS.glassNavy,
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 700,
              fontFamily: FONTS.heading,
              cursor: 'pointer',
            }}>Reload Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ScheduleRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('tab', 'schedule');
  return <Navigate to={`/admin/dispatch?${params.toString()}`} replace />;
}

// Field photo-scoring flow is now the "Field Assessment" tab of the
// consolidated Assessments hub. Old bookmarks/links to
// /admin/lawn-assessment land on that tab.
function LawnAssessmentRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('tab', 'field');
  return <Navigate to={`/admin/lawn-assessments?${params.toString()}`} replace />;
}

function FleetRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedTab = params.get('tab');
  params.set('tab', requestedTab === 'analytics' ? 'analytics' : 'maintenance');
  return <Navigate to={`/admin/equipment?${params.toString()}`} replace />;
}

// Legacy review funnel consolidated onto /rate. Old /review/:token links
// (already texted to customers, plus the tech-trigger response URL) redirect
// to the modern RatePage so there is a single review experience. Token +
// any tracking query string are preserved.
function ReviewLinkRedirect() {
  const { token } = useParams();
  const location = useLocation();
  return <Navigate to={`/rate/${token}${location.search}`} replace />;
}

function EstimateRoute() {
  const { search } = useLocation();
  const page = <EstimateViewPage />;
  return new URLSearchParams(search).get('website') === '1' ? page : <WavesShell>{page}</WavesShell>;
}

// Legacy linked-estimate booking page: its estimate fetch expected JSON from
// an endpoint that serves the estimate HTML page, so it never loaded (and
// every hit inflated view_count). Nothing mints these links anymore — send
// them to the canonical estimate view, which books the same visit.
function BookEstimateRedirect() {
  const { estimateToken } = useParams();
  return <Navigate to={`/estimate/${estimateToken}`} replace />;
}

// The standalone recap player was retired 2026-07-09 — the tech-approved
// "Your Visit, in Motion" clip renders inside the service report itself
// (RecapVideoCard, pest reports only). Recap SMS links already texted to
// customers keep working by redirecting to the report, anchored at the clip.
function RecapLinkRedirect() {
  const { token } = useParams();
  return <Navigate to={`/report/${token}#visit-recap`} replace />;
}

// Safari home-screen bookmark: keep admin identity + visual-viewport
// vars on the whole /admin/* tree, including /admin/login (outside the layout).
function AdminSafariShell() {
  const { pathname } = useLocation();
  const active = isAdminPath(pathname);
  useAdminBookmarkMeta(active);
  useAdminViewport(active);
  return null;
}

// The portal-domain newsletter landing was retired 2026-07-09 — the astro
// site's wavespestcontrol.com/newsletter is the single landing (owner call:
// one page, not two mirrors). Already-shared portal links keep working via
// this hard redirect; /newsletter/archive/:id stays (the Learn tab's reader).
function NewsletterExternalRedirect() {
  useEffect(() => {
    window.location.replace('https://www.wavespestcontrol.com/newsletter/');
  }, []);
  return null;
}

function ExternalRedirect({ to }) {
  useEffect(() => {
    window.location.replace(`${to}${window.location.search}${window.location.hash}`);
  }, [to]);
  return null;
}

import {
  ESTIMATE_MARKETING_REDIRECTS,
  ESTIMATE_QUOTE_URL,
} from './lib/estimateMarketingRedirects';
import LoginPage from './pages/LoginPage';
import AdminLoginPage from './pages/AdminLoginPage';
import AdminChangePasswordPage from './pages/AdminChangePasswordPage';
import AdminForgotPasswordPage from './pages/AdminForgotPasswordPage';
import AdminResetPasswordPage from './pages/AdminResetPasswordPage';
import AdminLayout from './components/AdminLayoutV2';
import TechLayout from './components/TechLayout';
import TechNavigationLock from './components/tech/TechNavigationLock';
import InstallPrompt from './components/InstallPrompt';
import BiometricGate from './components/BiometricGate';
import PublicFunnelTracking from './components/analytics/PublicFunnelTracking';
import useAdminBookmarkMeta from './hooks/useAdminBookmarkMeta';
import useAdminViewport from './hooks/useAdminViewport';
import { isAdminPath } from './lib/adminBookmarkMeta';
import AdminTabRedirect from './components/admin/AdminTabRedirect';
import { isNativeApp } from './native/platform';
import WavesShell from './components/brand/WavesShell';
import { lazy, Suspense } from 'react';

function showReloadToast() {
  if (document.getElementById('chunk-reload-toast')) return;
  const el = document.createElement('div');
  el.id = 'chunk-reload-toast';
  el.textContent = 'New version available — reloading…';
  Object.assign(el.style, {
    position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
    background: '#009CDE', color: '#fff', padding: '10px 20px', borderRadius: '8px',
    fontSize: '14px', fontWeight: '600', fontFamily: "'DM Sans', sans-serif",
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)', zIndex: '99999',
  });
  document.body.appendChild(el);
}

// Rendered when a lazy chunk still fails after the one automatic reload —
// a friendly retry beats the blank screen the rethrow used to produce.
function ChunkLoadFallback() {
  const operatorPath = /^\/(admin|tech)(\/|$)/.test(window.location.pathname);
  if (!operatorPath) {
    return (
      <CustomerFailureScreen
        title="Couldn’t load this page"
        message="Check your connection and try again."
        onRetry={() => { sessionStorage.removeItem('chunk-reload-attempted'); window.location.reload(); }}
      />
    );
  }
  return (
    <div style={{
      minHeight: '100vh', background: '#FAF8F3', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, fontFamily: FONTS.body, boxSizing: 'border-box',
    }}>
      <div style={{
        width: 'min(420px, 100%)', background: '#fff', border: '1px solid #E7E2D7',
        borderRadius: 8, padding: 24, textAlign: 'center', boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.glassNavy, marginBottom: 8, fontFamily: FONTS.heading }}>
          Couldn&rsquo;t load this page
        </div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 1.5 }}>
          Check your connection and try again.
        </div>
        <button
          onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); window.location.reload(); }}
          style={{
            minHeight: 42, padding: '0 18px', background: COLORS.glassNavy, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700,
            fontFamily: FONTS.heading, cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// Route-level Suspense placeholder. One element for every lazy page instead
// of 45 inline copies on the retired slate #94a3b8: inside the admin shell
// --text-secondary resolves to the zinc/stone token; elsewhere (tech
// portal's dark theme) the slate fallback keeps its contrast.
function RouteFallback({ label = 'Loading...' }) {
  return (
    <div style={{ color: 'var(--text-secondary, #94a3b8)', padding: 40, fontSize: 14 }} role="status">
      {label}
    </div>
  );
}

function lazyWithRetry(factory) {
  return lazy(async () => {
    try {
      const mod = await factory();
      sessionStorage.removeItem('chunk-reload-attempted');
      return mod;
    } catch (err) {
      const msg = String(err?.message || '');
      const isChunkError = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(msg);
      if (isChunkError) {
        if (!sessionStorage.getItem('chunk-reload-attempted')) {
          sessionStorage.setItem('chunk-reload-attempted', '1');
          showReloadToast();
          setTimeout(() => window.location.reload(), 1200);
          return { default: () => null };
        }
        // Already auto-reloaded once — show a retry screen instead of
        // rethrowing into a blank page.
        return { default: ChunkLoadFallback };
      }
      throw err;
    }
  });
}
// Perf (owner ask 2026-07-09): these were EAGER imports riding the entry
// bundle — a customer opening an estimate/report link downloaded the whole
// admin platform plus the 500KB+ PortalPage before first paint. Same
// lazyWithRetry + per-route Suspense treatment as the rest of the pages;
// no rendered-output change.
const StaffDocumentLibrary = lazyWithRetry(() => import('./components/staffDocuments/Library'));
const PortalPage = lazyWithRetry(() => import('./pages/PortalPage'));
const ReportViewPage = lazyWithRetry(() => import('./pages/ReportViewPage'));
const VisitSummaryPage = lazyWithRetry(() => import('./pages/VisitSummaryPage'));
const ProjectReportViewPage = lazyWithRetry(() => import('./pages/ProjectReportViewPage'));
const AdminReviewsPage = lazyWithRetry(() => import('./pages/admin/ReviewsPage'));
const AdminDispatchPage = lazyWithRetry(() => import('./pages/admin/AdminDispatchPage'));
const AdminInventoryPage = lazyWithRetry(() => import('./pages/admin/InventoryPage'));
const AdminCommunicationsPage = lazyWithRetry(() => import('./pages/admin/CommunicationsPageV2'));
const AdminCustomersPage = lazyWithRetry(() => import('./pages/admin/CustomersPageV2'));
const AdminReferralsPage = lazyWithRetry(() => import('./pages/admin/ReferralsPageV2'));
const AdminDashboardPage = lazyWithRetry(() => import('./pages/admin/DashboardPageV2'));
const AdminPipelinePage = lazyWithRetry(() => import('./pages/admin/EstimatesPageV2'));
const AdminAgentEstimatePage = lazyWithRetry(() => import('./pages/admin/AgentEstimatePage'));
const AdminCommercialProposalPage = lazyWithRetry(() => import('./pages/admin/CommercialProposalPage'));
const TechHomePage = lazyWithRetry(() => import('./pages/tech/TechHomePage'));
const PayGrowth = lazyWithRetry(() => import('./components/payGrowth/PayGrowth'));
const TechProtocolsPage = lazyWithRetry(() => import('./pages/tech/TechProtocolsPage'));
const LawnReportViewPage = lazyWithRetry(() => import('./pages/LawnReportViewPage'));
const PestReportViewPage = lazyWithRetry(() => import('./pages/PestReportViewPage'));
const AdminAssessmentsHubPage = lazyWithRetry(() => import('./pages/admin/AssessmentsHubPage'));
const AdminRecruitingPage = lazyWithRetry(() => import('./pages/admin/RecruitingPage'));
const TechLawnDiagnosticPage = lazyWithRetry(() => import('./pages/tech/TechLawnDiagnosticPage'));
const TechSocialPostPage = lazyWithRetry(() => import('./pages/tech/TechSocialPostPage'));
const AdminAdsPage = lazyWithRetry(() => import('./pages/admin/AdsPage'));
const AdminSEOPage = lazyWithRetry(() => import('./pages/admin/SEOPage'));
const AdminBlogPage = lazyWithRetry(() => import('./pages/admin/BlogPage'));
const AgentsHubPage = lazyWithRetry(() => import('./pages/admin/AgentsHubPage'));
const KnowledgeHubPage = lazyWithRetry(() => import('./pages/admin/KnowledgeHubPage'));
const AdminSettingsPage = lazyWithRetry(() => import('./pages/admin/SettingsPage'));
const PestPressureSettingsPage = lazyWithRetry(() => import('./pages/admin/PestPressureSettingsPage'));
const RatePage = lazyWithRetry(() => import('./pages/RatePage'));
const CardPage = lazyWithRetry(() => import('./pages/CardPage'));
const AdminSocialMediaPage = lazyWithRetry(() => import('./pages/admin/SocialMediaPage'));
const AdminTaxPage = lazyWithRetry(() => import('./pages/admin/TaxPage'));
const AdminToolHealthPage = lazyWithRetry(() => import('./pages/admin/ToolHealthPage'));
const AdminPriceMatchPage = lazyWithRetry(() => import('./pages/admin/PriceMatchPage'));
const AdminDuplicateCustomersPage = lazyWithRetry(() => import('./pages/admin/DuplicateCustomersPage'));
const AdminEquipmentPage = lazyWithRetry(() => import('./pages/admin/EquipmentPage'));
const AdminTurfHeightReviewPage = lazyWithRetry(() => import('./pages/admin/TurfHeightReviewPage'));
const AdminInvoicesPage = lazyWithRetry(() => import('./pages/admin/AdminInvoicesPage'));
const BillingRecoveryPage = lazyWithRetry(() => import('./pages/admin/BillingRecoveryPage'));
const PayersPage = lazyWithRetry(() => import('./pages/admin/PayersPage'));
const AdminContractsPage = lazyWithRetry(() => import('./pages/admin/ContractsPage'));
const PayPage = lazyWithRetry(() => import('./pages/PayPageV2'));
const StatementPayPage = lazyWithRetry(() => import('./pages/StatementPayPage'));
const ReceiptPage = lazyWithRetry(() => import('./pages/ReceiptPage'));
const ContractSignPage = lazyWithRetry(() => import('./pages/ContractSignPage'));
const TrackPage = lazyWithRetry(() => import('./pages/TrackPage'));
// One page for both self-serve scheduling flows (owner 2026-09-04). Keyed
// per flow: the re-service covered card links to /reschedule, and an SPA hop
// must mount a fresh instance (result / slot / AI-filter state is per flow).
const ScheduleFlowPage = lazyWithRetry(() => import('./pages/ScheduleFlowPage'));
const AppointmentPage = lazyWithRetry(() => import('./pages/AppointmentPage'));
const SecureAppointmentPage = lazyWithRetry(() => import('./pages/SecureAppointmentPage'));
const PrepGuidePage = lazyWithRetry(() => import('./pages/PrepGuidePage'));
const PriceChangeNoticePage = lazyWithRetry(() => import('./pages/PriceChangeNoticePage'));
const EstimateViewPage = lazyWithRetry(() => import('./pages/EstimateViewPage'));
const TimeTrackingPage = lazyWithRetry(() => import('./pages/admin/TimeTrackingPage'));
const ServiceLibraryPage = lazyWithRetry(() => import('./pages/admin/ServiceLibraryPage'));
const ProjectsPage = lazyWithRetry(() => import('./pages/admin/ProjectsPage'));
const NewsletterPage = lazyWithRetry(() => import('./pages/admin/NewsletterPage'));
const CompliancePage = lazyWithRetry(() => import('./pages/admin/CompliancePage'));
const PricingHubPage = lazyWithRetry(() => import('./pages/admin/PricingHubPage'));
const DesignSystemPage = lazyWithRetry(() => import('./pages/admin/_DesignSystemPage'));
const DesignSystemFlagsPage = lazyWithRetry(() => import('./pages/admin/_DesignSystemFlagsPage'));
const AdminBankingPage = lazyWithRetry(() => import('./pages/admin/BankingPage'));
const AdminMorePage = lazyWithRetry(() => import('./pages/admin/MorePage'));
const PublicBookingPage = lazyWithRetry(() => import('./pages/PublicBookingPage'));
const ServiceOutlinePage = lazyWithRetry(() => import('./pages/ServiceOutlinePage'));
const NewsletterArchivePage = lazyWithRetry(() => import('./pages/NewsletterArchivePage'));

// Route-tree error boundary: keyed on pathname so navigating away from a
// crashed page automatically clears the fallback. Customer routes previously
// had NO boundary — any render crash blanked the whole app.
function RoutesErrorBoundary({ children }) {
  const location = useLocation();
  const customerGlass = !/^\/(admin|tech)(\/|$)/.test(location.pathname);
  return <PageErrorBoundary key={location.pathname} customerGlass={customerGlass}>{children}</PageErrorBoundary>;
}

// A profile-only link (every push minted before the composers carry the
// property) means that profile's PRIMARY — the house unstamped visits belong
// to — so a non-primary selection on the same profile still switches back
// rather than keeping an arbitrary house whose scoped reads would hide the
// notified visit. While the primary entry is not known yet (list still
// loading, or failed) the link stays pending — mounting the portal would open
// the notification under the wrong house (codex #4207 r2); the guard's
// propertiesError check fails it closed.
function profileOnlyTarget({ propertyScopedDestination, sameProfile, primaryEntry, selectedId }) {
  if (!propertyScopedDestination || !sameProfile || !selectedId) return { fallbackPropertyId: null, primaryUnknown: false };
  if (!primaryEntry) return { fallbackPropertyId: null, primaryUnknown: true };
  const primaryId = String(primaryEntry.propertyId);
  return { fallbackPropertyId: selectedId !== primaryId ? primaryId : null, primaryUnknown: false };
}

// Tabs whose reads are customer-wide: a push to them requires only the right
// profile — neither the profile's primary (uncapped codex r1r P1) nor the
// house a completion or receipt push names (uncapped codex r1v P1): a retired
// house must not turn a report or an invoice into "Property unavailable" when
// the tab itself opens. Home, Visits and My Property follow the selection.
const CUSTOMER_WIDE_TABS = ['billing', 'refer', 'documents', 'plan', 'learn'];

// Where a notification deep link wants the portal to be, judged against the
// session's current selection and property list. Pure: everything the route
// guard decides is derived here so the guard itself stays a small effect.
//
// Saved-property destination (GATE_APP_PROPERTY_SCOPE): a push that knows
// the visit's house names it too (`notificationPropertyId`). The full
// selection is compared — same profile but a different saved property still
// switches. A profile-only link keeps today's rule: switch only when the
// PROFILE differs (see profileOnlyTarget).
export function resolveNotificationTarget({ search, customer, properties, selectedProperty }) {
  const params = new URLSearchParams(search);
  const targetProperty = params.get('notificationProperty');
  // The hint means something only against a SAVED-property list. A
  // PROFILE-shaped list (gate off, or rolled back after the push was
  // minted) has no houses to match, so the hint degrades to a profile-only
  // link — today's routing — instead of "Property unavailable" (uncapped
  // codex r1t P1). An EMPTY list (still loading, or failed) keeps the hint:
  // the pending / fail-closed paths of the guard own that case.
  // Saved entries carry a propertyId (null for a row-less profile) and a key;
  // profile entries carry neither.
  const listIsProfileShaped = properties.length > 0
    && !properties.some((property) => property.key || Object.prototype.hasOwnProperty.call(property, 'propertyId'));
  const propertyScopedDestination = !CUSTOMER_WIDE_TABS.includes(params.get('tab') || 'dashboard');
  const targetPropertyId = listIsProfileShaped || !propertyScopedDestination ? null : params.get('notificationPropertyId');
  const profileDiffers = !!targetProperty && String(customer?.id) !== targetProperty;
  const sameProfile = !!targetProperty && !profileDiffers;
  const currentProfileEntries = properties.filter((property) => String(property.customerId || property.id) === String(customer?.id));
  const primaryEntry = currentProfileEntries.find((property) => property.isPrimaryProperty) || null;
  const selectedId = selectedProperty?.propertyId ? String(selectedProperty.propertyId) : '';
  // A saved property named by the link wins over the profile-only rule.
  const profileOnly = targetPropertyId
    ? { fallbackPropertyId: null, primaryUnknown: false }
    : profileOnlyTarget({ propertyScopedDestination, sameProfile, primaryEntry, selectedId });
  const resolvedTargetPropertyId = targetPropertyId || profileOnly.fallbackPropertyId;
  const savedDiffers = sameProfile && !!resolvedTargetPropertyId && selectedId !== resolvedTargetPropertyId;
  return {
    targetProperty,
    resolvedTargetPropertyId,
    propertyScopedDestination,
    currentProfileEntries,
    primaryUnknown: profileOnly.primaryUnknown,
    pending: profileDiffers || savedDiffers || profileOnly.primaryUnknown,
  };
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading, error, customer, properties, propertiesError, switchProperty, refreshProperties, selectedProperty = null } = useAuth();
  const location = useLocation();
  const { targetProperty, resolvedTargetPropertyId, propertyScopedDestination, currentProfileEntries, primaryUnknown, pending } = resolveNotificationTarget({
    search: location.search, customer, properties, selectedProperty,
  });
  const targetPending = isAuthenticated && pending;
  const switchingTarget = useRef(null);
  const [targetError, setTargetError] = useState(null);
  // A target the in-memory list does not carry is re-read ONCE before it is
  // refused: a house added after this tab last loaded `properties` (a warm
  // app session, an in-app bell tap) is valid on the server but absent here
  // (GitHub codex r10 P2). `refreshedFor` records the destination whose
  // re-read finished, so the second pass decides on the fresh list; a
  // failed re-read sets propertiesError and fails closed above.
  const refreshingFor = useRef(null);
  const [refreshedFor, setRefreshedFor] = useState(null);
  useEffect(() => {
    const destination = `${targetProperty}:${resolvedTargetPropertyId || ''}`;
    // Destination satisfied (or gone): release the in-flight guard so a
    // later return to the same notification URL — Billing, a manual switch
    // to another house, Back — switches again instead of loading forever
    // (uncapped codex r2d P1).
    if (!targetPending) { switchingTarget.current = null; return; }
    if (loading || switchingTarget.current === destination) return;
    if (propertiesError) { setTargetError('Your service properties could not be checked. Try again.'); return; }
    const refreshUnseen = () => {
      if (refreshedFor === destination) return false;
      if (refreshingFor.current === destination) return true;
      refreshingFor.current = destination;
      Promise.resolve(typeof refreshProperties === 'function' ? refreshProperties() : false)
        .catch(() => false)
        .finally(() => { refreshingFor.current = null; setRefreshedFor(destination); });
      return true;
    };
    if (primaryUnknown) {
      // Entries for this profile are listed but none is its primary (the
      // office retired it): nothing safe to open — fail closed.
      if (currentProfileEntries.length > 0) setTargetError('This notification belongs to a property that is no longer available on your account.');
      return; // otherwise keep waiting for the list
    }
    // Saved-property entries carry composite ids (GATE_APP_PROPERTY_SCOPE);
    // a notification names the PROFILE, so match on the entry's customer.
    // The saved-property list omits an active profile whose houses were ALL
    // retired. A CUSTOMER-WIDE destination (Billing, Documents…) on such a
    // sibling profile is still reachable — /auth/select-property verifies
    // ownership and refuses a foreign profile — so only PROPERTY-scoped
    // destinations require the profile to list a house (uncapped codex r1x
    // P1); a customer-wide one proceeds to the ownership-checked switch.
    if (propertyScopedDestination && !properties.some((property) => String(property.customerId || property.id) === targetProperty)) {
      if (refreshUnseen()) return;
      setTargetError('This notification belongs to a property that is no longer available on your account.');
      return;
    }
    // A named saved property must be one of that profile's listed entries.
    const savedEntry = resolvedTargetPropertyId
      ? properties.find((property) => String(property.customerId || property.id) === targetProperty && String(property.propertyId) === resolvedTargetPropertyId)
      : null;
    if (resolvedTargetPropertyId && !savedEntry) {
      if (refreshUnseen()) return;
      setTargetError('This notification belongs to a property that is no longer available on your account.');
      return;
    }
    switchingTarget.current = destination;
    // select-property verifies ownership again on the server. The portal
    // stays unmounted until the authenticated customer matches the target.
    void switchProperty(savedEntry ? { customerId: savedEntry.customerId, propertyId: savedEntry.propertyId } : targetProperty).then((switched) => {
      if (!switched) setTargetError('This property could not be opened. Try again.');
    }).catch(() => setTargetError('This property could not be opened. Try again.'));
  }, [targetPending, targetProperty, resolvedTargetPropertyId, primaryUnknown, propertyScopedDestination, currentProfileEntries.length, loading, properties, propertiesError, switchProperty, refreshProperties, refreshedFor]);
  // The auth-check screen mounts the same glass scene as the portal, so
  // loading renders like the real UI instead of a flat placeholder.
  useGlassSurface(loading || targetPending);

  if (targetPending && targetError) {
    return <CustomerFailureScreen title="Property unavailable" message={targetError} onRetry={() => window.location.assign('/')} />;
  }
  if (loading || targetPending) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        fontFamily: FONTS.body,
        padding: 24,
        boxSizing: 'border-box',
      }}>
        <div data-glass="card" style={{
          width: 'min(360px, 100%)',
          background: '#fff',
          border: '1px solid #E7E2D7',
          borderRadius: 16,
          padding: 28,
          textAlign: 'center',
          color: COLORS.glassNavy,
          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
          position: 'relative',
        }}>
          <img
            src="/waves-logo.png"
            alt="Waves"
            style={{
              height: 64,
              display: 'block',
              margin: '0 auto 14px',
              animation: 'portalPulse 1.4s ease infinite',
            }}
          />
          <div style={{ fontSize: 17, fontWeight: 700, fontFamily: FONTS.heading }}>Loading your portal</div>
          {/* Headline + logo only on a normal (fast) load — but while useAuth
              retries a transient failure, still tell the customer what's
              happening instead of an indefinite generic check. */}
          {error && (
            <p style={{ fontSize: 14, color: '#475569', margin: '6px 0 0', lineHeight: 1.45 }}>{error}</p>
          )}
        </div>
        <style>{`
          @keyframes portalPulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.04); opacity: 0.76; }
          }
        `}</style>
      </div>
    );
  }

  const next = `${location.pathname}${location.search}${location.hash}`;
  return isAuthenticated ? children : <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
}

export default function App() {
  const app = (
    <AuthProvider>
      <TechNavigationLock>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PublicFunnelTracking />
        <AdminSafariShell />
        <InstallPrompt />
        <BiometricGate>
        <RoutesErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* WavesShell wraps (owner 2026-07-06): every customer page gets
              the standard top bar + trust footer. */}
          <Route path="/rate/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><RatePage /></WavesShell></Suspense>} />
          {/* Digital business card — navy glass scene, so the fallback wash
              matches the scene instead of the light doc wash. */}
          <Route path="/card/:token" element={<Suspense fallback={<div style={{background:'#04395E',minHeight:'100vh'}}/>}><WavesShell><CardPage /></WavesShell></Suspense>} />
          <Route path="/report/project/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><ProjectReportViewPage /></WavesShell></Suspense>} />
          <Route path="/report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><ReportViewPage /></WavesShell></Suspense>} />
          <Route path="/recap/:token" element={<RecapLinkRedirect />} />
          <Route path="/visit/:token" element={<Suspense fallback={<div />}><WavesShell><VisitSummaryPage /></WavesShell></Suspense>} />
          <Route path="/pay/statement/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><StatementPayPage /></Suspense>} />
          <Route path="/pay/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PayPage /></Suspense>} />
          <Route path="/receipt/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ReceiptPage /></Suspense>} />
          <Route path="/contract/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ContractSignPage /></Suspense>} />
          <Route path="/track/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><TrackPage /></Suspense>} />
          <Route path="/reschedule/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ScheduleFlowPage key="reschedule" flow="reschedule" /></Suspense>} />
          <Route path="/reservice/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ScheduleFlowPage key="reservice" flow="reservice" /></Suspense>} />
          <Route path="/appointment/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><AppointmentPage /></Suspense>} />
          <Route path="/secure/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><SecureAppointmentPage /></Suspense>} />
          <Route path="/prep/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PrepGuidePage /></Suspense>} />
          <Route path="/price-change/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PriceChangeNoticePage /></Suspense>} />
          {Object.entries(ESTIMATE_MARKETING_REDIRECTS).map(([slug, destination]) => (
            <Route key={slug} path={`/estimate/${slug}`} element={<ExternalRedirect to={destination} />} />
          ))}
          <Route path="/estimate/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><EstimateRoute /></Suspense>} />
          {/* #EDF4FA fallbacks = glass-adjacent wash, not the warm legacy
              #FAF8F3 — these pages all mount the glass scene, so a warm
              fallback reads as the old theme flashing before glass. The
              /newsletter keeps its dark hero. The /pay group joined the full
              scene 2026-07-09 (pro wash retired), so it uses the same wash. */}
          <Route path="/lawn-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><LawnReportViewPage /></WavesShell></Suspense>} />
          <Route path="/pest-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><PestReportViewPage /></WavesShell></Suspense>} />
          <Route path="/service-outlines/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><ServiceOutlinePage /></WavesShell></Suspense>} />
          <Route path="/review/:token" element={<ReviewLinkRedirect />} />
          <Route path="/book" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PublicBookingPage /></Suspense>} />
          <Route path="/estimate" element={<ExternalRedirect to={ESTIMATE_QUOTE_URL} />} />
          <Route path="/quote" element={<ExternalRedirect to={ESTIMATE_QUOTE_URL} />} />
          <Route path="/newsletter" element={<NewsletterExternalRedirect />} />
          <Route path="/newsletter/archive/:id" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><NewsletterArchivePage /></Suspense>} />
          <Route path="/book/:estimateToken" element={<BookEstimateRedirect />} />
          <Route path="/admin/login" element={isNativeApp() ? <Navigate to="/" replace /> : <AdminLoginPage />} />
          <Route path="/admin/change-password" element={isNativeApp() ? <Navigate to="/" replace /> : <AdminChangePasswordPage />} />
          <Route path="/admin/forgot-password" element={isNativeApp() ? <Navigate to="/" replace /> : <AdminForgotPasswordPage />} />
          <Route path="/admin/reset-password" element={isNativeApp() ? <Navigate to="/" replace /> : <AdminResetPasswordPage />} />
          <Route path="/tech" element={isNativeApp() ? <Navigate to="/" replace /> : <TechLayout />}>
            <Route index element={<Suspense fallback={<RouteFallback label="Loading..." />}><TechHomePage /></Suspense>} />
            <Route path="tools" element={<Suspense fallback={<RouteFallback label="Loading tools…" />}><TechHomePage section="tools" /></Suspense>} />
            <Route path="more" element={<Suspense fallback={<RouteFallback label="Loading…" />}><TechHomePage section="more" /></Suspense>} />
            {/* Field estimates use the canonical server-priced builder. The retired
                tech-only calculator duplicated prices client-side and its SMS call
                posted the wrong request shape, so it could show “sent” after a 400. */}
            <Route path="estimate" element={<Navigate to="/admin/pipeline?tab=new" replace />} />
            <Route path="protocols" element={<Suspense fallback={<RouteFallback label="Loading protocols..." />}><TechProtocolsPage /></Suspense>} />
            <Route path="documents" element={<Suspense fallback={<RouteFallback label="Loading documents..." />}><StaffDocumentLibrary /></Suspense>} />
            <Route path="pay-growth" element={<Suspense fallback={<RouteFallback label="Loading pay and growth…" />}><PayGrowth /></Suspense>} />
            <Route path="lawn-diagnostic" element={<Suspense fallback={<RouteFallback label="Loading lawn diagnostic..." />}><TechLawnDiagnosticPage /></Suspense>} />
            <Route path="social-post" element={<Suspense fallback={<RouteFallback label="Loading social post..." />}><TechSocialPostPage /></Suspense>} />
          </Route>
          <Route path="/admin" element={isNativeApp() ? <Navigate to="/" replace /> : <PageErrorBoundary><AdminLayout /></PageErrorBoundary>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<Suspense fallback={<RouteFallback label="Loading dashboard..." />}><AdminDashboardPage /></Suspense>} />
            <Route path="customers" element={<Suspense fallback={<RouteFallback label="Loading customers..." />}><AdminCustomersPage /></Suspense>} />
            <Route path="customers/new" element={<Suspense fallback={<RouteFallback label="Loading customer form..." />}><AdminCustomersPage /></Suspense>} />
            <Route path="customers/duplicates" element={<Suspense fallback={<RouteFallback label="Loading duplicates..." />}><AdminDuplicateCustomersPage /></Suspense>} />
            <Route path="pipeline" element={<Suspense fallback={<RouteFallback label="Loading pipeline..." />}><AdminPipelinePage /></Suspense>} />
            {/* Legacy Pipeline entry routes preserve notifications/bookmarks but
                no longer mount duplicate copies of EstimatesPageV2. */}
            <Route path="estimates" element={<AdminTabRedirect to="/admin/pipeline" tab="estimates" preserveTabs={['leads', 'estimates', 'new', 'pricing']} />} />
            <Route path="agent-estimate" element={<Suspense fallback={<div style={{color:'#71717a',padding:40}}>Loading Agent Estimate...</div>}><AdminAgentEstimatePage /></Suspense>} />
            <Route path="estimates/:estimateId/proposal" element={<Suspense fallback={<RouteFallback label="Loading proposal..." />}><AdminCommercialProposalPage /></Suspense>} />
            {/* /admin/dispatch is now the canonical dispatcher surface
                — Board tab (phase 2 v1) + Schedule tab (existing
                DispatchPageV2). /admin/schedule still works (redirects
                to the Schedule tab) so existing bookmarks and internal
                links aren't broken. */}
            <Route path="dispatch" element={<Suspense fallback={<RouteFallback label="Loading dispatch..." />}><AdminDispatchPage /></Suspense>} />
            <Route path="schedule" element={<ScheduleRedirect />} />
            <Route path="revenue" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="communications" element={<Suspense fallback={<RouteFallback label="Loading communications..." />}><AdminCommunicationsPage /></Suspense>} />
            <Route path="reviews" element={<Suspense fallback={<RouteFallback label="Loading reviews..." />}><AdminReviewsPage /></Suspense>} />
            <Route path="ads" element={<Navigate to="/admin/ppc" replace />} />
            <Route path="ppc" element={<Suspense fallback={<RouteFallback label="Loading PPC..." />}><AdminAdsPage /></Suspense>} />
            <Route path="seo" element={<Suspense fallback={<RouteFallback label="Loading SEO..." />}><AdminSEOPage /></Suspense>} />
            {/* Content Engine + Registry are now tabs inside the Blog hub; keep the old paths as redirects for bookmarks and server actionUrls. */}
            <Route path="content-engine" element={<AdminTabRedirect to="/admin/blog" tab="autopilot" />} />
            <Route path="content-registry" element={<AdminTabRedirect to="/admin/blog" tab="registry" />} />
            <Route path="data-hygiene" element={<AdminTabRedirect to="/admin/agents" tab="hygiene" />} />
            <Route path="agents" element={<Suspense fallback={<RouteFallback label="Loading agents..." />}><AgentsHubPage /></Suspense>} />
            <Route path="agent-decisions" element={<AdminTabRedirect to="/admin/agents" tab="decisions" />} />
            {/* The documented owner-approval queue URL (feature-gates.js, service docs) — the queue lives as a hub tab. */}
            <Route path="drafts" element={<AdminTabRedirect to="/admin/agents" tab="drafts" />} />
            <Route path="blog" element={<Suspense fallback={<RouteFallback label="Loading blog..." />}><AdminBlogPage /></Suspense>} />
            <Route path="knowledge" element={<Suspense fallback={<RouteFallback label="Loading knowledge..." />}><KnowledgeHubPage /></Suspense>} />
            <Route path="referrals" element={<Suspense fallback={<RouteFallback label="Loading referrals..." />}><AdminReferralsPage /></Suspense>} />
            <Route path="social-media" element={<Suspense fallback={<RouteFallback label="Loading social media..." />}><AdminSocialMediaPage /></Suspense>} />
            <Route path="tax" element={<Suspense fallback={<RouteFallback label="Loading tax..." />}><AdminTaxPage /></Suspense>} />
            <Route path="pricing" element={<AdminTabRedirect to="/admin/pricing-logic" queryKey="area" tab="strategy" />} />
            {/* /admin/lawn-assessments is the consolidated Assessments hub
                (Lead Magnets tab + Field Assessment tab). The old standalone
                /admin/lawn-assessment route redirects to the Field tab so
                bookmarks and internal links keep working. */}
            <Route path="lawn-assessment" element={<LawnAssessmentRedirect />} />
            <Route path="lawn-assessments" element={<Suspense fallback={<RouteFallback label="Loading assessments..." />}><AdminAssessmentsHubPage /></Suspense>} />
            <Route path="recruiting" element={<Suspense fallback={<RouteFallback label="Loading recruiting..." />}><AdminRecruitingPage /></Suspense>} />
            <Route
              path="lawn-protocol"
              element={(
                <AdminTabRedirect
                  to="/admin/service-library"
                  tab="protocols"
                  remapQuery={{
                    from: "tab",
                    to: "protocolTab",
                    preserveValues: ["mixing", "overview", "readiness", "products", "gates", "calibration", "bridges", "audit"],
                  }}
                />
              )}
            />
            {/* Turf-height OCR review queue stays mounted — it is the only
                client consumer of the review/resolve endpoints in
                server/routes/admin-turf-height.js (discrepancy / ocr_failed
                triage) until that workflow gets a real home in Schedule. */}
            <Route path="turf-height" element={<Suspense fallback={<RouteFallback label="Loading turf height review..." />}><AdminTurfHeightReviewPage /></Suspense>} />
            <Route path="equipment-calibration" element={<AdminTabRedirect to="/admin/equipment" tab="calibrations" />} />
            <Route path="equipment" element={<Suspense fallback={<RouteFallback label="Loading equipment..." />}><AdminEquipmentPage /></Suspense>} />
            <Route
              path="kb"
              element={(
                <AdminTabRedirect
                  to="/admin/knowledge"
                  queryKey="area"
                  tab="base"
                  remapQuery={{
                    from: "tab",
                    to: "kbTab",
                    preserveValues: ["browse", "create", "field", "audit", "tokens"],
                  }}
                />
              )}
            />
            <Route path="invoices" element={<Suspense fallback={<RouteFallback label="Loading invoices..." />}><AdminInvoicesPage /></Suspense>} />
            <Route path="billing-recovery" element={<Suspense fallback={<RouteFallback label="Loading billing recovery..." />}><BillingRecoveryPage /></Suspense>} />
            <Route path="payers" element={<Suspense fallback={<RouteFallback label="Loading payers..." />}><PayersPage /></Suspense>} />
            <Route path="inventory" element={<Suspense fallback={<RouteFallback label="Loading inventory..." />}><AdminInventoryPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<RouteFallback label="Loading settings..." />}><AdminSettingsPage /></Suspense>} />
            <Route path="settings/pest-pressure" element={<Suspense fallback={<RouteFallback label="Loading Pest Pressure settings..." />}><PestPressureSettingsPage /></Suspense>} />
            <Route path="health" element={<AdminTabRedirect to="/admin/customers" tab="health" queryKey="view" />} />
            <Route path="timetracking" element={<Suspense fallback={<RouteFallback label="Loading time tracking..." />}><TimeTrackingPage /></Suspense>} />
            <Route path="leads" element={<AdminTabRedirect to="/admin/pipeline" tab="leads" />} />
            <Route path="fleet" element={<FleetRedirect />} />
            <Route path="service-library" element={<Suspense fallback={<RouteFallback label="Loading service library..." />}><ServiceLibraryPage /></Suspense>} />
            <Route path="projects" element={<Suspense fallback={<RouteFallback label="Loading projects..." />}><ProjectsPage /></Suspense>} />
            <Route path="contracts" element={<Suspense fallback={<RouteFallback label="Loading contracts..." />}><AdminContractsPage /></Suspense>} />
            <Route path="documents" element={<AdminTabRedirect to="/admin/contracts" tab="templates" />} />
            <Route path="document-requests" element={<AdminTabRedirect to="/admin/contracts" tab="requests" />} />
            <Route path="discounts" element={<AdminTabRedirect to="/admin/service-library" tab="discounts" />} />
            <Route path="compliance" element={<Suspense fallback={<RouteFallback label="Loading compliance..." />}><CompliancePage /></Suspense>} />
            <Route path="credentials" element={<AdminTabRedirect to="/admin/compliance" tab="credentials" />} />
            <Route path="newsletter" element={<Suspense fallback={<RouteFallback label="Loading newsletter..." />}><NewsletterPage /></Suspense>} />
            <Route path="call-recordings" element={<Navigate to="/admin/communications" replace />} />
            <Route path="phone-numbers" element={<Navigate to="/admin/communications" replace />} />
            <Route path="email" element={<AdminTabRedirect to="/admin/communications" tab="email" tabInHash />} />
            <Route path="banking" element={<Suspense fallback={<RouteFallback label="Loading banking..." />}><AdminBankingPage /></Suspense>} />
            <Route path="pricing-logic" element={<Suspense fallback={<RouteFallback label="Loading pricing..." />}><PricingHubPage /></Suspense>} />
            <Route path="pricing-reality-check" element={<Navigate to="/admin/pricing-logic?section=reality" replace />} />
            <Route path="tool-health" element={<Suspense fallback={<RouteFallback label="Loading tool health..." />}><AdminToolHealthPage /></Suspense>} />
            <Route path="auto-dispatch" element={<AdminTabRedirect to="/admin/agents" tab="dispatch" />} />
            <Route path="price-match" element={<Suspense fallback={<RouteFallback label="Loading price match..." />}><AdminPriceMatchPage /></Suspense>} />
            <Route path="price-change" element={<AdminTabRedirect to="/admin/pricing-logic" queryKey="area" tab="notices" />} />
            <Route path="more" element={<Suspense fallback={<RouteFallback label="Loading…" />}><AdminMorePage /></Suspense>} />
            <Route path="_design-system" element={<Suspense fallback={<RouteFallback label="Loading design system..." />}><DesignSystemPage /></Suspense>} />
            <Route path="_design-system/flags" element={<Suspense fallback={<RouteFallback label="Loading flags..." />}><DesignSystemFlagsPage /></Suspense>} />
            {/* Unknown staff URLs stay in the admin shell instead of falling through to the customer login. */}
            <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
          </Route>
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}>
                  <PortalPage />
                </Suspense>
              </ProtectedRoute>
            }
          />
        </Routes>
        </RoutesErrorBoundary>
        <CustomerDialogHost />
        </BiometricGate>
      </BrowserRouter>
      </TechNavigationLock>
    </AuthProvider>
  );
  return app;
}
