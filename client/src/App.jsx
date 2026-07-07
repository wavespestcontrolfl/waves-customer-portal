import React, { Component } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { GrowthBookProvider } from '@growthbook/growthbook-react';
import { growthbook } from './lib/growthbook';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { COLORS, FONTS } from './theme-brand';
import { useGlassSurface } from './glass/glass-engine';
import Icon from './components/Icon';

class PageErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[Page crash]', error, info.componentStack); }
  render() {
    if (this.state.error) {
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
            <div style={{ fontSize: 18, fontWeight: 850, color: COLORS.blueDeeper, marginBottom: 8, fontFamily: FONTS.heading }}>Something went wrong</div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 1.5 }}>
            {this.state.error.message}
            </div>
            <button onClick={() => { this.setState({ error: null }); window.location.reload(); }} style={{
              minHeight: 42,
              padding: '0 18px',
              background: COLORS.blueDeeper,
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

import { SERVICE_ESTIMATE_SLUGS } from './lib/serviceEstimateSlugs';
import LoginPage from './pages/LoginPage';
import PortalPage from './pages/PortalPage';
import AdminLoginPage from './pages/AdminLoginPage';
import AdminLayout from './components/AdminLayoutV2';
import TechLayout from './components/TechLayout';
import InstallPrompt from './components/InstallPrompt';
import BiometricGate from './components/BiometricGate';
import PublicFunnelTracking from './components/analytics/PublicFunnelTracking';
import { isNativeApp } from './native/platform';
import AdminReviewsPage from './pages/admin/ReviewsPage';
import AdminDispatchPage from './pages/admin/AdminDispatchPage';
import AdminInventoryPage from './pages/admin/InventoryPage';
import AdminRevenuePage from './pages/admin/RevenuePage';
import AdminCommunicationsPage from './pages/admin/CommunicationsPageV2';
import AdminCustomersPage from './pages/admin/CustomersPageV2';
import AdminReferralsPage from './pages/admin/ReferralsPageV2';
import ReportViewPage from './pages/ReportViewPage';
import ProjectReportViewPage from './pages/ProjectReportViewPage';
import RecapViewPage from './pages/RecapViewPage';
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
  return (
    <div style={{
      minHeight: '100vh', background: '#FAF8F3', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, fontFamily: FONTS.body, boxSizing: 'border-box',
    }}>
      <div style={{
        width: 'min(420px, 100%)', background: '#fff', border: '1px solid #E7E2D7',
        borderRadius: 8, padding: 24, textAlign: 'center', boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
      }}>
        <div style={{ fontSize: 18, fontWeight: 850, color: COLORS.blueDeeper, marginBottom: 8, fontFamily: FONTS.heading }}>
          Couldn&rsquo;t load this page
        </div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 1.5 }}>
          Check your connection and try again.
        </div>
        <button
          onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); window.location.reload(); }}
          style={{
            minHeight: 42, padding: '0 18px', background: COLORS.blueDeeper, color: '#fff',
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
const AdminDashboardPage = lazyWithRetry(() => import('./pages/admin/DashboardPageV2'));
const AdminEstimatePage = lazyWithRetry(() => import('./pages/admin/EstimatesPageV2'));
const AdminPipelinePage = lazyWithRetry(() => import('./pages/admin/EstimatesPageV2'));
const TechHomePage = lazyWithRetry(() => import('./pages/tech/TechHomePage'));
const TechEstimatorPage = lazyWithRetry(() => import('./pages/tech/TechEstimatorPage'));
const TechProtocolsPage = lazyWithRetry(() => import('./pages/tech/TechProtocolsPage'));
const LawnReportViewPage = lazyWithRetry(() => import('./pages/LawnReportViewPage'));
const PestReportViewPage = lazyWithRetry(() => import('./pages/PestReportViewPage'));
const AdminPhotoAssessmentsPage = lazyWithRetry(() => import('./pages/admin/PhotoAssessmentsPage'));
const LawnReportV2Preview = lazyWithRetry(() => import('./pages/LawnReportV2Preview'));
const TechLawnDiagnosticPage = lazyWithRetry(() => import('./pages/tech/TechLawnDiagnosticPage'));
const TechSocialPostPage = lazyWithRetry(() => import('./pages/tech/TechSocialPostPage'));
const AdminAdsPage = lazyWithRetry(() => import('./pages/admin/AdsPage'));
const AdminSEOPage = lazyWithRetry(() => import('./pages/admin/SEOPage'));
const AdminBlogPage = lazyWithRetry(() => import('./pages/admin/BlogPage'));
const AgentsHubPage = lazyWithRetry(() => import('./pages/admin/AgentsHubPage'));
const AdminKnowledgePage = lazyWithRetry(() => import('./pages/admin/KnowledgePage'));
const AdminSettingsPage = lazyWithRetry(() => import('./pages/admin/SettingsPage'));
const PestPressureSettingsPage = lazyWithRetry(() => import('./pages/admin/PestPressureSettingsPage'));
const RatePage = lazyWithRetry(() => import('./pages/RatePage'));
const AdminSocialMediaPage = lazyWithRetry(() => import('./pages/admin/SocialMediaPage'));
const AdminTaxPage = lazyWithRetry(() => import('./pages/admin/TaxPage'));
const AdminPricingPage = lazyWithRetry(() => import('./pages/admin/PricingStrategyPage'));
const AdminToolHealthPage = lazyWithRetry(() => import('./pages/admin/ToolHealthPage'));
const AdminAutoDispatchPage = lazyWithRetry(() => import('./pages/admin/AutoDispatchPage'));
const AdminPriceMatchPage = lazyWithRetry(() => import('./pages/admin/PriceMatchPage'));
const AdminLawnAssessmentPage = lazyWithRetry(() => import('./pages/admin/LawnAssessmentPanel'));
const AdminEquipmentPage = lazyWithRetry(() => import('./pages/admin/EquipmentPage'));
const AdminEquipmentCalibrationPage = lazyWithRetry(() => import('./pages/admin/EquipmentCalibrationPanel'));
const AdminLawnProtocolPage = lazyWithRetry(() => import('./pages/admin/LawnProtocolCommandCenterPage'));
const AdminTurfHeightReviewPage = lazyWithRetry(() => import('./pages/admin/TurfHeightReviewPage'));
const AdminKnowledgeBasePage = lazyWithRetry(() => import('./pages/admin/KnowledgeBasePage'));
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
const PrepGuidePage = lazyWithRetry(() => import('./pages/PrepGuidePage'));
const TrackPreviewPage = lazyWithRetry(() => import('./pages/TrackPreviewPage'));
const EstimateViewPage = lazyWithRetry(() => import('./pages/EstimateViewPage'));
const CustomerHealthPage = lazyWithRetry(() => import('./pages/admin/CustomerHealthPage'));
const TimeTrackingPage = lazyWithRetry(() => import('./pages/admin/TimeTrackingPage'));
const LeadsPage = lazyWithRetry(() => import('./pages/admin/LeadsPage'));
const ServiceLibraryPage = lazyWithRetry(() => import('./pages/admin/ServiceLibraryPage'));
const ProjectsPage = lazyWithRetry(() => import('./pages/admin/ProjectsPage'));
const CredentialsPage = lazyWithRetry(() => import('./pages/admin/CredentialsPage'));
const NewsletterPage = lazyWithRetry(() => import('./pages/admin/NewsletterPage'));
const CompliancePage = lazyWithRetry(() => import('./pages/admin/CompliancePage'));
const PricingLogicPage = lazyWithRetry(() => import('./pages/admin/PricingLogicPage'));
const DesignSystemPage = lazyWithRetry(() => import('./pages/admin/_DesignSystemPage'));
const DesignSystemFlagsPage = lazyWithRetry(() => import('./pages/admin/_DesignSystemFlagsPage'));
const AdminEmailPage = lazyWithRetry(() => import('./pages/admin/EmailPage'));
const AdminBankingPage = lazyWithRetry(() => import('./pages/admin/BankingPage'));
const AdminMorePage = lazyWithRetry(() => import('./pages/admin/MorePage'));
const PublicBookingPage = lazyWithRetry(() => import('./pages/PublicBookingPage'));
const QuotePage = lazyWithRetry(() => import('./pages/QuotePage'));
const LawnCareIncludedPage = lazyWithRetry(() => import('./pages/LawnCareIncludedPage'));
const ServiceOutlinePage = lazyWithRetry(() => import('./pages/ServiceOutlinePage'));
const NewsletterLandingPage = lazyWithRetry(() => import('./pages/NewsletterLandingPage'));
const NewsletterArchivePage = lazyWithRetry(() => import('./pages/NewsletterArchivePage'));
const ButtonExamples = lazyWithRetry(() => import('./pages/ButtonExamples'));

function EstimatePublicGateway() {
  const { token } = useParams();
  const slug = String(token || '').toLowerCase();
  if (SERVICE_ESTIMATE_SLUGS.has(slug)) {
    return <QuotePage serviceSlug={slug} />;
  }
  // Tokened estimates get the standard shell chrome (owner 2026-07-06);
  // the slug branch keeps the quote wizard's own hero.
  return <WavesShell><EstimateViewPage /></WavesShell>;
}

// Route-tree error boundary: keyed on pathname so navigating away from a
// crashed page automatically clears the fallback. Customer routes previously
// had NO boundary — any render crash blanked the whole app.
function RoutesErrorBoundary({ children }) {
  const location = useLocation();
  return <PageErrorBoundary key={location.pathname}>{children}</PageErrorBoundary>;
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
          color: COLORS.blueDeeper,
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
          <Route path="/rate/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><WavesShell><RatePage /></WavesShell></Suspense>} />
          <Route path="/report/project/:token" element={<WavesShell><ProjectReportViewPage /></WavesShell>} />
          <Route path="/report/:token" element={<WavesShell><ReportViewPage /></WavesShell>} />
          <Route path="/recap/:token" element={<WavesShell><RecapViewPage /></WavesShell>} />
          {import.meta.env.DEV && <Route path="/report-v2-preview" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><LawnReportV2Preview /></Suspense>} />}
          <Route path="/pay/statement/:token" element={<Suspense fallback={<div style={{background:'#F8FAFB',minHeight:'100vh'}}/>}><StatementPayPage /></Suspense>} />
          <Route path="/pay/:token" element={<Suspense fallback={<div style={{background:'#F8FAFB',minHeight:'100vh'}}/>}><PayPage /></Suspense>} />
          <Route path="/receipt/:token" element={<Suspense fallback={<div style={{background:'#F8FAFB',minHeight:'100vh'}}/>}><ReceiptPage /></Suspense>} />
          <Route path="/contract/:token" element={<Suspense fallback={<div style={{background:'#F8FAFB',minHeight:'100vh'}}/>}><ContractSignPage /></Suspense>} />
          <Route path="/track/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><TrackPage /></Suspense>} />
          <Route path="/reschedule/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><ReschedulePage /></Suspense>} />
          <Route path="/prep/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><PrepGuidePage /></Suspense>} />
          <Route path="/track-preview" element={<Suspense fallback={<div style={{background:'#FEF7E0',minHeight:'100vh'}}/>}><TrackPreviewPage /></Suspense>} />
          <Route path="/estimate/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><EstimatePublicGateway /></Suspense>} />
          {/* glass-adjacent wash, not the warm legacy #FAF8F3 — these report
              pages mount the glass scene, so a warm fallback reads as the old
              theme flashing before glass */}
          <Route path="/lawn-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><LawnReportViewPage /></WavesShell></Suspense>} />
          <Route path="/pest-report/:token" element={<Suspense fallback={<div style={{background:'#EDF4FA',minHeight:'100vh'}}/>}><WavesShell><PestReportViewPage /></WavesShell></Suspense>} />
          <Route path="/lawn-care/what-is-included" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><LawnCareIncludedPage /></Suspense>} />
          <Route path="/service-outlines/:token" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><WavesShell><ServiceOutlinePage /></WavesShell></Suspense>} />
          <Route path="/review/:token" element={<ReviewLinkRedirect />} />
          <Route path="/book" element={<Suspense fallback={<div style={{background:'#F5F1EB',minHeight:'100vh'}}/>}><PublicBookingPage /></Suspense>} />
          <Route path="/estimate" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><QuotePage /></Suspense>} />
          <Route path="/quote" element={<Navigate to="/estimate" replace />} />
          <Route path="/newsletter" element={<Suspense fallback={<div style={{background:'#1B2C5B',minHeight:'100vh'}}/>}><NewsletterLandingPage /></Suspense>} />
          <Route path="/newsletter/archive/:id" element={<Suspense fallback={<div style={{background:'#FEF7E0',minHeight:'100vh'}}/>}><NewsletterArchivePage /></Suspense>} />
          <Route path="/button-examples" element={<Suspense fallback={<div style={{background:'#FAF8F3',minHeight:'100vh'}}/>}><ButtonExamples /></Suspense>} />
          <Route path="/book/:estimateToken" element={<BookEstimateRedirect />} />
          <Route path="/admin/login" element={isNativeApp() ? <Navigate to="/" replace /> : <AdminLoginPage />} />
          <Route path="/tech" element={isNativeApp() ? <Navigate to="/" replace /> : <TechLayout />}>
            <Route index element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading...</div>}><TechHomePage /></Suspense>} />
            <Route path="estimate" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading estimator...</div>}><TechEstimatorPage /></Suspense>} />
            <Route path="protocols" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading protocols...</div>}><TechProtocolsPage /></Suspense>} />
            <Route path="lawn-diagnostic" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading lawn diagnostic...</div>}><TechLawnDiagnosticPage /></Suspense>} />
            <Route path="social-post" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading social post...</div>}><TechSocialPostPage /></Suspense>} />
          </Route>
          <Route path="/admin" element={isNativeApp() ? <Navigate to="/" replace /> : <PageErrorBoundary><AdminLayout /></PageErrorBoundary>}>
            <Route index element={<Navigate to="dashboard" />} />
            <Route path="dashboard" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading dashboard...</div>}><AdminDashboardPage /></Suspense>} />
            <Route path="customers" element={<AdminCustomersPage />} />
            <Route path="pipeline" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pipeline...</div>}><AdminPipelinePage /></Suspense>} />
            <Route path="estimates" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading estimator...</div>}><AdminEstimatePage /></Suspense>} />
            {/* /admin/dispatch is now the canonical dispatcher surface
                — Board tab (phase 2 v1) + Schedule tab (existing
                DispatchPageV2). /admin/schedule still works (redirects
                to the Schedule tab) so existing bookmarks and internal
                links aren't broken. */}
            <Route path="dispatch" element={<AdminDispatchPage />} />
            <Route path="schedule" element={<ScheduleRedirect />} />
            <Route path="revenue" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="communications" element={<AdminCommunicationsPage />} />
            <Route path="reviews" element={<AdminReviewsPage />} />
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
            <Route path="knowledge" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading knowledge base...</div>}><AdminKnowledgePage /></Suspense>} />
            <Route path="referrals" element={<AdminReferralsPage />} />
            <Route path="social-media" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading social media...</div>}><AdminSocialMediaPage /></Suspense>} />
            <Route path="tax" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading tax...</div>}><AdminTaxPage /></Suspense>} />
            <Route path="pricing" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pricing...</div>}><AdminPricingPage /></Suspense>} />
            <Route path="lawn-assessment" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading lawn assessment...</div>}><AdminLawnAssessmentPage /></Suspense>} />
            <Route path="lawn-assessments" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading assessments...</div>}><AdminPhotoAssessmentsPage /></Suspense>} />
            <Route path="lawn-protocol" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading lawn protocol...</div>}><AdminLawnProtocolPage /></Suspense>} />
            <Route path="turf-height" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading turf height review...</div>}><AdminTurfHeightReviewPage /></Suspense>} />
            <Route path="equipment-calibration" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading equipment calibration...</div>}><AdminEquipmentCalibrationPage /></Suspense>} />
            <Route path="equipment" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading equipment...</div>}><AdminEquipmentPage /></Suspense>} />
            <Route path="kb" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading knowledge base...</div>}><AdminKnowledgeBasePage /></Suspense>} />
            <Route path="invoices" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading invoices...</div>}><AdminInvoicesPage /></Suspense>} />
            <Route path="billing-recovery" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading billing recovery...</div>}><BillingRecoveryPage /></Suspense>} />
            <Route path="payers" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading payers...</div>}><PayersPage /></Suspense>} />
            <Route path="inventory" element={<AdminInventoryPage />} />
            <Route path="settings" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading settings...</div>}><AdminSettingsPage /></Suspense>} />
            <Route path="settings/pest-pressure" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading Pest Pressure settings...</div>}><PestPressureSettingsPage /></Suspense>} />
            <Route path="health" element={<Navigate to="/admin/customers?view=health" replace />} />
            <Route path="timetracking" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading time tracking...</div>}><TimeTrackingPage /></Suspense>} />
            <Route path="leads" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pipeline...</div>}><LeadsPage /></Suspense>} />
            <Route path="fleet" element={<FleetRedirect />} />
            <Route path="service-library" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading service library...</div>}><ServiceLibraryPage /></Suspense>} />
            <Route path="projects" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading projects...</div>}><ProjectsPage /></Suspense>} />
            <Route path="contracts" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading contracts...</div>}><AdminContractsPage /></Suspense>} />
            <Route path="documents" element={<Navigate to="/admin/contracts?tab=templates" replace />} />
            <Route path="document-requests" element={<Navigate to="/admin/contracts?tab=requests" replace />} />
            <Route path="discounts" element={<Navigate to="/admin/service-library?tab=discounts" replace />} />
            <Route path="compliance" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading compliance...</div>}><CompliancePage /></Suspense>} />
            <Route path="credentials" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading credentials...</div>}><CredentialsPage /></Suspense>} />
            <Route path="newsletter" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading newsletter...</div>}><NewsletterPage /></Suspense>} />
            <Route path="call-recordings" element={<Navigate to="/admin/communications" replace />} />
            <Route path="phone-numbers" element={<Navigate to="/admin/communications" replace />} />
            <Route path="email" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading email...</div>}><AdminEmailPage /></Suspense>} />
            <Route path="banking" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading banking...</div>}><AdminBankingPage /></Suspense>} />
            <Route path="pricing-logic" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pricing...</div>}><PricingLogicPage /></Suspense>} />
            <Route path="pricing-reality-check" element={<Navigate to="/admin/pricing-logic?section=reality" replace />} />
            <Route path="tool-health" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading tool health...</div>}><AdminToolHealthPage /></Suspense>} />
            <Route path="auto-dispatch" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading auto-dispatch...</div>}><AdminAutoDispatchPage /></Suspense>} />
            <Route path="price-match" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading price match...</div>}><AdminPriceMatchPage /></Suspense>} />
            <Route path="more" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading…</div>}><AdminMorePage /></Suspense>} />
            <Route path="_design-system" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading design system...</div>}><DesignSystemPage /></Suspense>} />
            <Route path="_design-system/flags" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading flags...</div>}><DesignSystemFlagsPage /></Suspense>} />
          </Route>
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <PortalPage />
              </ProtectedRoute>
            }
          />
        </Routes>
        </RoutesErrorBoundary>
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
