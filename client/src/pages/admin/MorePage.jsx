import { Link, useNavigate } from 'react-router-dom';
import {
  FileText, Clock, BookOpen, Star, Gift, Mail,
  Megaphone, Search as SearchIcon, Share2,
  Wrench, Truck, Package, ClipboardCheck, Leaf,
  Library, Brain,
  Receipt, Landmark, Calculator, Ruler,
  Activity, Settings as SettingsIcon,
  LogOut, ExternalLink, ChevronRight,
} from 'lucide-react';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const SECTIONS = [
  { section: 'Operations', items: [
    { path: '/admin/estimates', icon: FileText, label: 'Pipeline & Estimates' },
    { path: '/admin/timetracking', icon: Clock, label: 'Staff' },
    { path: '/admin/service-library', icon: BookOpen, label: 'Services' },
  ]},
  { section: 'Communications', items: [
    { path: '/admin/reviews', icon: Star, label: 'Reviews' },
    { path: '/admin/referrals', icon: Gift, label: 'Referrals' },
    { path: '/admin/email', icon: Mail, label: 'Email' },
  ]},
  { section: 'Marketing', items: [
    { path: '/admin/ppc', icon: Megaphone, label: 'PPC' },
    { path: '/admin/seo', icon: SearchIcon, label: 'SEO' },
    { path: '/admin/social-media', icon: Share2, label: 'Social Media' },
  ]},
  { section: 'Field & Equipment', items: [
    { path: '/admin/equipment', icon: Wrench, label: 'Equipment' },
    { path: '/admin/fleet', icon: Truck, label: 'Fleet & Mileage' },
    { path: '/admin/inventory', icon: Package, label: 'Inventory' },
    { path: '/admin/compliance', icon: ClipboardCheck, label: 'Compliance' },
    { path: '/admin/lawn-assessment', icon: Leaf, label: 'Lawn Assessment' },
  ]},
  { section: 'Intelligence', items: [
    { path: '/admin/knowledge', icon: Library, label: 'Knowledge Base' },
    { path: '/admin/kb', icon: Brain, label: 'Claudeopedia' },
  ]},
  { section: 'Finance', items: [
    { path: '/admin/invoices', icon: Receipt, label: 'Invoices' },
    { path: '/admin/banking', icon: Landmark, label: 'Banking' },
    { path: '/admin/tax', icon: Calculator, label: 'Tax Center' },
    { path: '/admin/pricing-logic', icon: Ruler, label: 'Pricing Logic' },
  ]},
  { section: 'System', items: [
    { path: '/admin/tool-health', icon: Activity, label: 'Tool Health' },
    { path: '/admin/settings', icon: SettingsIcon, label: 'Settings' },
  ]},
];

export default function MorePage() {
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    refetchFlags();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="md:hidden pb-4">
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-28 font-normal text-zinc-900 tracking-tight">More</h1>
        <p className="text-13 text-zinc-500 mt-1">Everything beyond the five tabs.</p>
      </div>

      {SECTIONS.map(({ section, items }) => (
        <section key={section} className="mt-2">
          <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-label text-zinc-500">
            {section}
          </div>
          <ul className="bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
            {items.map(({ path, icon: Icon, label }) => (
              <li key={path}>
                <Link
                  to={path}
                  className="flex items-center gap-3 px-4 h-14 active:bg-zinc-50 text-zinc-900"
                >
                  <Icon size={20} strokeWidth={1.75} className="text-zinc-600 shrink-0" />
                  <span className="flex-1 text-14">{label}</span>
                  <ChevronRight size={16} className="text-zinc-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="mt-6">
        <ul className="bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
          <li>
            <Link to="/" className="flex items-center gap-3 px-4 h-14 active:bg-zinc-50 text-zinc-600">
              <ExternalLink size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 text-14">Customer Portal</span>
              <ChevronRight size={16} className="text-zinc-400" />
            </Link>
          </li>
          <li>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 h-14 active:bg-alert-bg text-alert-fg"
            >
              <LogOut size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 text-14 text-left">Sign Out</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}
