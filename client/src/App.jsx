import React, { Component, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { GrowthBookProvider } from '@growthbook/growthbook-react';
import { growthbook } from './lib/growthbook';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { COLORS, FONTS } from './theme-brand';
import { CUSTOMER_SURFACE } from './theme-customer';
import { useGlassSurface } from './glass/glass-engine';
import Icon from './components/Icon';
import CustomerDialogHost from './components/brand/CustomerDialogHost';

function CustomerFailureScreen({ title, message, onRetry }) {
  useGlassSurface(true, 'full');
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
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 850, color: CUSTOMER_SURFACE.text, fontFamily: FONTS.heading }}>
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
            fontWeight: 850,
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
  componentDidCatch(error, info) { console.error('[Page crash]', error, info.componentStack); }
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
            <div style={{ fontSize: 18, fontWeight: 850, color: COLORS.glassNavy, marginBottom: 8, fontFamily: FONTS.heading }}>Something went wrong</div>
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
              fontWeight: 850,
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
import InstallPrompt from './components/InstallPrompt';
import BiometricGate from './components/BiometricGate';
import PublicFunnelTracking from './components/analytics/PublicFunnelTracking';
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
        <div style={{ fontSize: 18, fontWeight: 850, color: COLORS.glassNavy, marginBottom: 8, fontFamily: FONTS.heading }}>
          Couldn&rsquo;t load this page
        </div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 1.5 }}>
          Check your connection and try again.
        </div>
        <button
          onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); window.location.reload(); }}
          style={{
            minHeight: 42, padding: '0 18px', background: COLORS.glassNavy, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 850,
            fontFamily: FONTS.heading, cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
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
const PortalPage = lazyWithRetry(() => import('./pages/PortalPage'));
const ReportViewPage = lazyWithRetry(() => import('./pages/ReportViewPage'));
const ProjectReportViewPage = lazyWithRetry(() => import('./pages/ProjectReportViewPage'));
const AdminReviewsPage = lazyWithRetry(() => import('./pages/admin/ReviewsPage'));
const AdminDispatchPage = lazyWithRetry(() => import('./pages/admin/AdminDispatchPage'));
const AdminInventoryPage = lazyWithRetry(() => import('./pages/admin/InventoryPage'));
const AdminCommunicationsPage = lazyWithRetry(() => import('./pages/admin/CommunicationsPageV2'));
const AdminCustomersPage = lazyWithRetry(() => import('./pages/admin/CustomersPageV2'));
const AdminReferralsPage = lazyWithRetry(() => import('./pages/admin/ReferralsPageV2'));
const AdminDashboardPage = lazyWithRetry(() => import('./pages/admin/DashboardPageV2'));
const AdminPipelinePage = lazyWithRetry(() => import('./pages/admin/EstimatesPageV2'));
const AdminCommercialProposalPage = lazyWithRetry(() => import('./pages/admin/CommercialProposalPage'));
const TechHomePage = lazyWithRetry(() => import('./pages/tech/TechHomePage'));
const TechProtocolsPage = lazyWithRetry(() => import('./pages/tech/TechProtocolsPage'));
const LawnReportViewPage = lazyWithRetry(() => import('./pages/LawnReportViewPage'));
const PestReportViewPage = lazyWithRetry(() => import('./pages/PestReportViewPage'));
const AdminAssessmentsHubPage = lazyWithRetry(() => import('./pages/admin/AssessmentsHubPage'));
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
const ReschedulePage = lazyWithRetry(() => import('./pages/ReschedulePage'));
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
const AdminEmailPage = lazyWithRetry(() => import('./pages/admin/EmailPage'));
const AdminBankingPage = lazyWithRetry(() => import('./pages/admin/BankingPage'));
const AdminMorePage = lazyWithRetry(() => import('./pages/admin/MorePage'));
const PublicBookingPage = lazyWithRetry(() => import('./pages/PublicBookingPage'));
const LawnCareIncludedPage = lazyWithRetry(() => import('./pages/LawnCareIncludedPage'));
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

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading, error } = useAuth();
  const location = useLocation();
  // The auth-check screen mounts the same glass scene as the portal, so
  // loading renders like the real UI instead of a flat placeholder.
  useGlassSurface(loading, 'full');

  if (loading) {
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
          <div style={{ fontSize: 17, fontWeight: 850, fontFamily: FONTS.heading }}>Loading your portal</div>
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
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PublicFunnelTracking />
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
          <Route path="/pay/statement/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><StatementPayPage /></Suspense>} />
          <Route path="/pay/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PayPage /></Suspense>} />
          <Route path="/receipt/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ReceiptPage /></Suspense>} />
          <Route path="/contract/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ContractSignPage /></Suspense>} />
          <Route path="/track/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><TrackPage /></Suspense>} />
          <Route path="/reschedule/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><ReschedulePage /></Suspense>} />
          <Route path="/secure/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><SecureAppointmentPage /></Suspense>} />
          <Route path="/prep/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PrepGuidePage /></Suspense>} />
          <Route path="/price-change/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><PriceChangeNoticePage /></Suspense>} />
          {Object.entries(ESTIMATE_MARKETING_REDIRECTS).map(([slug, destination]) => (
            <Route key={slug} path={`/estimate/${slug}`} element={<ExternalRedirect to={destination} />} />
          ))}
          <Route path="/estimate/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><EstimateViewPage /></WavesShell></Suspense>} />
          {/* #EDF4FA fallbacks = glass-adjacent wash, not the warm legacy
              #FAF8F3 — these pages all mount the glass scene, so a warm
              fallback reads as the old theme flashing before glass. The
              /newsletter keeps its dark hero. The /pay group joined the full
              scene 2026-07-09 (pro wash retired), so it uses the same wash. */}
          <Route path="/lawn-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><LawnReportViewPage /></WavesShell></Suspense>} />
          <Route path="/pest-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><PestReportViewPage /></WavesShell></Suspense>} />
          <Route path="/lawn-care/what-is-included" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><LawnCareIncludedPage /></Suspense>} />
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
            <Route index element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading...</div>}><TechHomePage /></Suspense>} />
            {/* Field estimates use the canonical server-priced builder. The retired
                tech-only calculator duplicated prices client-side and its SMS call
                posted the wrong request shape, so it could show “sent” after a 400. */}
            <Route path="estimate" element={<Navigate to="/admin/pipeline?tab=new" replace />} />
            <Route path="protocols" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading protocols...</div>}><TechProtocolsPage /></Suspense>} />
            <Route path="lawn-diagnostic" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading lawn diagnostic...</div>}><TechLawnDiagnosticPage /></Suspense>} />
            <Route path="social-post" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading social post...</div>}><TechSocialPostPage /></Suspense>} />
          </Route>
          <Route path="/admin" element={isNativeApp() ? <Navigate to="/" replace /> : <PageErrorBoundary><AdminLayout /></PageErrorBoundary>}>
            <Route index element={<Navigate to="dashboard" />} />
            <Route path="dashboard" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading dashboard...</div>}><AdminDashboardPage /></Suspense>} />
            <Route path="customers" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading customers...</div>}><AdminCustomersPage /></Suspense>} />
            <Route path="customers/new" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading customer form...</div>}><AdminCustomersPage /></Suspense>} />
            <Route path="customers/duplicates" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading duplicates...</div>}><AdminDuplicateCustomersPage /></Suspense>} />
            <Route path="pipeline" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pipeline...</div>}><AdminPipelinePage /></Suspense>} />
            {/* Legacy Pipeline entry routes preserve notifications/bookmarks but
                no longer mount duplicate copies of EstimatesPageV2. */}
            <Route path="estimates" element={<AdminTabRedirect to="/admin/pipeline" tab="estimates" preserveTabs={['leads', 'estimates', 'new', 'pricing']} />} />
            <Route path="estimates/:estimateId/proposal" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading proposal...</div>}><AdminCommercialProposalPage /></Suspense>} />
            {/* /admin/dispatch is now the canonical dispatcher surface
                — Board tab (phase 2 v1) + Schedule tab (existing
                DispatchPageV2). /admin/schedule still works (redirects
                to the Schedule tab) so existing bookmarks and internal
                links aren't broken. */}
            <Route path="dispatch" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading dispatch...</div>}><AdminDispatchPage /></Suspense>} />
            <Route path="schedule" element={<ScheduleRedirect />} />
            <Route path="revenue" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="communications" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading communications...</div>}><AdminCommunicationsPage /></Suspense>} />
            <Route path="reviews" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading reviews...</div>}><AdminReviewsPage /></Suspense>} />
            <Route path="ads" element={<Navigate to="/admin/ppc" replace />} />
            <Route path="ppc" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading PPC...</div>}><AdminAdsPage /></Suspense>} />
            <Route path="seo" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading SEO...</div>}><AdminSEOPage /></Suspense>} />
            {/* Content Engine + Registry are now tabs inside the Blog hub; keep the old paths as redirects for bookmarks and server actionUrls. */}
            <Route path="content-engine" element={<Navigate to="/admin/blog?tab=autopilot" replace />} />
            <Route path="content-registry" element={<Navigate to="/admin/blog?tab=registry" replace />} />
            <Route path="data-hygiene" element={<Navigate to="/admin/agents?tab=hygiene" replace />} />
            <Route path="agents" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading agents...</div>}><AgentsHubPage /></Suspense>} />
            <Route path="agent-decisions" element={<Navigate to="/admin/agents?tab=decisions" replace />} />
            <Route path="blog" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading blog...</div>}><AdminBlogPage /></Suspense>} />
            <Route path="knowledge" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading knowledge...</div>}><KnowledgeHubPage /></Suspense>} />
            <Route path="referrals" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading referrals...</div>}><AdminReferralsPage /></Suspense>} />
            <Route path="social-media" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading social media...</div>}><AdminSocialMediaPage /></Suspense>} />
            <Route path="tax" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading tax...</div>}><AdminTaxPage /></Suspense>} />
            <Route path="pricing" element={<AdminTabRedirect to="/admin/pricing-logic" queryKey="area" tab="strategy" />} />
            {/* /admin/lawn-assessments is the consolidated Assessments hub
                (Lead Magnets tab + Field Assessment tab). The old standalone
                /admin/lawn-assessment route redirects to the Field tab so
                bookmarks and internal links keep working. */}
            <Route path="lawn-assessment" element={<LawnAssessmentRedirect />} />
            <Route path="lawn-assessments" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading assessments...</div>}><AdminAssessmentsHubPage /></Suspense>} />
            <Route
              path="lawn-protocol"
              element={(
                <AdminTabRedirect
                  to="/admin/service-library"
                  tab="protocols"
                  remapQuery={{
                    from: "tab",
                    to: "protocolTab",
                    preserveValues: ["overview", "readiness", "products", "gates", "calibration", "bridges", "audit"],
                  }}
                />
              )}
            />
            {/* Turf-height OCR review queue stays mounted — it is the only
                client consumer of the review/resolve endpoints in
                server/routes/admin-turf-height.js (discrepancy / ocr_failed
                triage) until that workflow gets a real home in Schedule. */}
            <Route path="turf-height" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading turf height review...</div>}><AdminTurfHeightReviewPage /></Suspense>} />
            <Route path="equipment-calibration" element={<AdminTabRedirect to="/admin/equipment" tab="calibrations" />} />
            <Route path="equipment" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading equipment...</div>}><AdminEquipmentPage /></Suspense>} />
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
            <Route path="invoices" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading invoices...</div>}><AdminInvoicesPage /></Suspense>} />
            <Route path="billing-recovery" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading billing recovery...</div>}><BillingRecoveryPage /></Suspense>} />
            <Route path="payers" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading payers...</div>}><PayersPage /></Suspense>} />
            <Route path="inventory" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading inventory...</div>}><AdminInventoryPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading settings...</div>}><AdminSettingsPage /></Suspense>} />
            <Route path="settings/pest-pressure" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading Pest Pressure settings...</div>}><PestPressureSettingsPage /></Suspense>} />
            <Route path="health" element={<Navigate to="/admin/customers?view=health" replace />} />
            <Route path="timetracking" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading time tracking...</div>}><TimeTrackingPage /></Suspense>} />
            <Route path="leads" element={<AdminTabRedirect to="/admin/pipeline" tab="leads" />} />
            <Route path="fleet" element={<FleetRedirect />} />
            <Route path="service-library" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading service library...</div>}><ServiceLibraryPage /></Suspense>} />
            <Route path="projects" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading projects...</div>}><ProjectsPage /></Suspense>} />
            <Route path="contracts" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading contracts...</div>}><AdminContractsPage /></Suspense>} />
            <Route path="documents" element={<Navigate to="/admin/contracts?tab=templates" replace />} />
            <Route path="document-requests" element={<Navigate to="/admin/contracts?tab=requests" replace />} />
            <Route path="discounts" element={<Navigate to="/admin/service-library?tab=discounts" replace />} />
            <Route path="compliance" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading compliance...</div>}><CompliancePage /></Suspense>} />
            <Route path="credentials" element={<AdminTabRedirect to="/admin/compliance" tab="credentials" />} />
            <Route path="newsletter" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading newsletter...</div>}><NewsletterPage /></Suspense>} />
            <Route path="call-recordings" element={<Navigate to="/admin/communications" replace />} />
            <Route path="phone-numbers" element={<Navigate to="/admin/communications" replace />} />
            <Route path="email" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading email...</div>}><AdminEmailPage /></Suspense>} />
            <Route path="banking" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading banking...</div>}><AdminBankingPage /></Suspense>} />
            <Route path="pricing-logic" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pricing...</div>}><PricingHubPage /></Suspense>} />
            <Route path="pricing-reality-check" element={<Navigate to="/admin/pricing-logic?section=reality" replace />} />
            <Route path="tool-health" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading tool health...</div>}><AdminToolHealthPage /></Suspense>} />
            <Route path="auto-dispatch" element={<AdminTabRedirect to="/admin/dispatch" tab="automation" />} />
            <Route path="price-match" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading price match...</div>}><AdminPriceMatchPage /></Suspense>} />
            <Route path="price-change" element={<AdminTabRedirect to="/admin/pricing-logic" queryKey="area" tab="notices" />} />
            <Route path="more" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading…</div>}><AdminMorePage /></Suspense>} />
            <Route path="_design-system" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading design system...</div>}><DesignSystemPage /></Suspense>} />
            <Route path="_design-system/flags" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading flags...</div>}><DesignSystemFlagsPage /></Suspense>} />
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
    </AuthProvider>
  );
  // GrowthBook React requires a REAL instance — with no client key there is
  // none, and <GrowthBookProvider growthbook={undefined}> can crash the SPA.
  // Skip the provider entirely instead; no feature hooks are mounted while
  // the lane is dark, and any future hook must tolerate the missing context
  // exactly as it tolerates fallback values.
  return growthbook
    ? <GrowthBookProvider growthbook={growthbook}>{app}</GrowthBookProvider>
    : app;
}
