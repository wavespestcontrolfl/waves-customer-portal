import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { COLORS, FONTS } from './theme';
import LoginPage from './pages/LoginPage';
import PortalPage from './pages/PortalPage';
import OnboardingPage from './pages/OnboardingPage';
import AdminLoginPage from './pages/AdminLoginPage';
import AdminLayout from './components/AdminLayout';
import TechLayout from './components/TechLayout';
import InstallPrompt from './components/InstallPrompt';
import AdminDashboardPage from './pages/admin/DashboardPage';
import EstimateViewPage from './pages/EstimateViewPage';
import AdminReviewsPage from './pages/admin/ReviewsPage';
import AdminSchedulePage from './pages/admin/SchedulePage';
import AdminInventoryPage from './pages/admin/InventoryPage';
import AdminRevenuePage from './pages/admin/RevenuePage';
import AdminCommunicationsPage from './pages/admin/CommunicationsPage';
import AdminCustomersPage from './pages/admin/CustomersPage';
import AdminReferralsPage from './pages/admin/ReferralsPage';
import ReportViewPage from './pages/ReportViewPage';
import { lazy, Suspense } from 'react';
const AdminEstimatePage = lazy(() => import('./pages/admin/EstimatePage'));
const TechHomePage = lazy(() => import('./pages/tech/TechHomePage'));
const TechEstimatorPage = lazy(() => import('./pages/tech/TechEstimatorPage'));
const AdminAdsPage = lazy(() => import('./pages/admin/AdsPage'));
const AdminSEOPage = lazy(() => import('./pages/admin/SEOPage'));
const AdminVoiceAgentPage = lazy(() => import('./pages/admin/VoiceAgentPage'));
const AdminBlogPage = lazy(() => import('./pages/admin/BlogPage'));
const AdminKnowledgePage = lazy(() => import('./pages/admin/KnowledgePage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const RatePage = lazy(() => import('./pages/RatePage'));
const AdminSocialMediaPage = lazy(() => import('./pages/admin/SocialMediaPage'));
const AdminTaxPage = lazy(() => import('./pages/admin/TaxPage'));
const AdminPricingPage = lazy(() => import('./pages/admin/PricingStrategyPage'));
import BookingPage from './pages/BookingPage';

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(135deg, ${COLORS.navy}, ${COLORS.navyLight})`,
        fontFamily: FONTS.body,
      }}>
        <div style={{ textAlign: 'center', color: '#fff' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, margin: '0 auto 16px',
            background: `linear-gradient(135deg, ${COLORS.wavesBlue}, ${COLORS.blueBright})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, fontWeight: 800, fontFamily: FONTS.heading,
            animation: 'pulse 1.5s ease infinite',
          }}>W</div>
          <p style={{ fontSize: 14, opacity: 0.7 }}>Loading your portal...</p>
        </div>
        <style>{`
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.05); opacity: 0.8; }
          }
        `}</style>
      </div>
    );
  }

  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <InstallPrompt />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboard/:token" element={<OnboardingPage />} />
          <Route path="/estimate/:token" element={<EstimateViewPage />} />
          <Route path="/rate/:token" element={<Suspense fallback={<div style={{background:'#1E7FD9',minHeight:'100vh'}}/>}><RatePage /></Suspense>} />
          <Route path="/report/:token" element={<ReportViewPage />} />
          <Route path="/book/:estimateToken" element={<BookingPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/tech" element={<TechLayout />}>
            <Route index element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading...</div>}><TechHomePage /></Suspense>} />
            <Route path="estimate" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading estimator...</div>}><TechEstimatorPage /></Suspense>} />
          </Route>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="dashboard" />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="customers" element={<AdminCustomersPage />} />
            <Route path="estimates" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading estimator...</div>}><AdminEstimatePage /></Suspense>} />
            <Route path="schedule" element={<AdminSchedulePage />} />
            <Route path="dispatch" element={<Navigate to="/admin/schedule" replace />} />
            <Route path="revenue" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="communications" element={<AdminCommunicationsPage />} />
            <Route path="reviews" element={<AdminReviewsPage />} />
            <Route path="ads" element={<Navigate to="/admin/ppc" replace />} />
            <Route path="ppc" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading PPC...</div>}><AdminAdsPage /></Suspense>} />
            <Route path="seo" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading SEO...</div>}><AdminSEOPage /></Suspense>} />
            <Route path="voice-agent" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading voice agent...</div>}><AdminVoiceAgentPage /></Suspense>} />
            <Route path="blog" element={<Navigate to="/admin/seo" replace />} />
            <Route path="knowledge" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading knowledge base...</div>}><AdminKnowledgePage /></Suspense>} />
            <Route path="referrals" element={<AdminReferralsPage />} />
            <Route path="social-media" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading social media...</div>}><AdminSocialMediaPage /></Suspense>} />
            <Route path="tax" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading tax...</div>}><AdminTaxPage /></Suspense>} />
            <Route path="pricing" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading pricing...</div>}><AdminPricingPage /></Suspense>} />
            <Route path="inventory" element={<AdminInventoryPage />} />
            <Route path="settings" element={<Suspense fallback={<div style={{color:'#94a3b8',padding:40}}>Loading settings...</div>}><AdminSettingsPage /></Suspense>} />
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
      </BrowserRouter>
    </AuthProvider>
  );
}
