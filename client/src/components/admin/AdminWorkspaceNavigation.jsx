import { useId } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, Pin, Search, Sparkles, X } from 'lucide-react';
import { Button, UiSurface } from '../ui';
import { cn } from '../ui/cn';
import useAdminNavigation from '../../hooks/useAdminNavigation';
import { markUsageSource } from '../../lib/adminUsage';
import NotificationBell from '../NotificationBell';

const rowClass = 'ui-control ui-action ui-control-compact flex w-full min-w-0 items-center gap-2 rounded text-left text-14 font-medium text-zinc-600 hover:bg-zinc-100 no-underline';

export function WorkspaceLink({ item, children, active, onNavigate, source = 'sidebar', className }) {
  const location = useLocation();
  return <Link to={item.path} aria-current={active ? 'page' : undefined}
    className={cn(rowClass, active && 'bg-zinc-100 text-zinc-900', className)}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      if (`${location.pathname}${location.search}${location.hash}` !== item.path) markUsageSource(source);
      onNavigate?.();
    }}>{children || item.label}</Link>;
}

export function WorkspaceGroup({ group, onNavigate, unreadCount, source = 'sidebar' }) {
  const panelId = useId();
  const { expanded, toggleGroup, selection } = useAdminNavigation();
  const hasChildren = !group.target || group.items.length > 1;
  const isExpanded = hasChildren && Boolean(expanded[group.id]);
  const isActive = selection.groupId === group.id;
  const Icon = group.icon;
  const label = <><Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden /><span className="min-w-0 flex-1">{group.label}</span>
    {group.id === 'communications' && unreadCount > 0 && <>
      <span className="sr-only">, {unreadCount} unread conversations</span>
      <span aria-hidden className="rounded-full bg-alert-fg px-1.5 text-14 text-white">{unreadCount > 99 ? '99+' : unreadCount}</span>
    </>}</>;
  const expansion = <ChevronDown size={16} aria-hidden className={cn('shrink-0 transition-transform', isExpanded && 'rotate-180')} />;
  return <div>
    <div className={cn('flex items-stretch rounded', isActive && 'bg-zinc-100')}>
      {group.target ? <WorkspaceLink item={group.target} active={isActive && !isExpanded && selection.itemId === group.target.id} onNavigate={onNavigate} source={source}>
        {label}
      </WorkspaceLink> : <Button variant="ghost" className={rowClass} aria-expanded={isExpanded} aria-controls={panelId} onClick={() => toggleGroup(group.id)}>
        {label}{expansion}
      </Button>}
      {group.target && hasChildren && <Button variant="ghost" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.label}`} aria-expanded={isExpanded} aria-controls={panelId}
        onClick={() => toggleGroup(group.id)} className="shrink-0 !px-2 min-w-[36px] max-lg:min-w-11 [@media(any-pointer:coarse)]:min-w-11">{expansion}</Button>}
    </div>
    {hasChildren && <div id={panelId} hidden={!isExpanded} className="ml-6 border-l border-zinc-200 pl-2">
      {group.items.map((item) => <WorkspaceLink key={item.id} item={item} active={selection.itemId === item.id} onNavigate={onNavigate} source={source} className="!px-2" />)}
    </div>}
  </div>;
}

export function PinnedWorkspaceLinks({ onNavigate, source = 'sidebar' }) {
  const { pinnedItems, selection } = useAdminNavigation();
  if (!pinnedItems.length) return null;
  return <div role="group" aria-label="Pinned pages" className="mb-2">
    <h2 className="m-0 px-3 pb-1 pt-2 text-14 font-normal text-zinc-500">Pinned</h2>
    {pinnedItems.map((item) => <WorkspaceLink key={item.id} item={item} source={source} active={selection.itemId === item.id} onNavigate={onNavigate}>
      <Pin size={16} className="shrink-0" aria-hidden /><span>{item.label}</span>
    </WorkspaceLink>)}
  </div>;
}

export default function AdminWorkspaceNavigation({ user, isMobile, onClose, onAsk, onSearch, onLogout, unreadCount }) {
  const navigation = useAdminNavigation();
  if (!navigation) return null;
  const { groups } = navigation;
  return <UiSurface density="compact" className="flex min-h-0 flex-1 flex-col text-zinc-900">
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-3">
      <img src="/waves-logo.png" alt="Waves" className="h-7" />
      <span className="text-16 font-medium" aria-hidden>Waves</span>
      <span className="flex-1" />
      {isMobile ? <Button variant="ghost" onClick={onClose} aria-label="Close menu" className="!px-3"><X size={18} aria-hidden /></Button> : <NotificationBell type="admin" />}
    </div>
    <div className="shrink-0 space-y-1 px-3 py-2">
      <Button variant="secondary" onClick={onSearch} className="w-full !justify-start" aria-label="Search pages"><Search size={18} aria-hidden /><span className="flex-1 text-left">Search pages</span><kbd className="text-14 font-normal">⌘K</kbd></Button>
      <Button variant="ghost" onClick={onAsk} className="w-full !justify-start"><Sparkles size={18} aria-hidden />Ask Waves</Button>
    </div>
    <nav aria-label="Admin workspaces" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <PinnedWorkspaceLinks onNavigate={onClose} />
      {['Daily work', 'Manage'].map((section) => {
        const entries = groups.filter((group) => group.section === section);
        return entries.length > 0 && <div key={section} role="group" aria-label={section} className="mb-2">
          <h2 className="m-0 px-3 pb-1 pt-2 text-14 font-normal text-zinc-500">{section}</h2>
          {entries.map((group) => <WorkspaceGroup key={group.id} group={group} onNavigate={onClose} unreadCount={unreadCount} />)}
        </div>;
      })}
    </nav>
    <div className="shrink-0 border-t border-zinc-200 px-2 py-2">
      {groups.filter((group) => group.section === 'Preferences').map((group) => <WorkspaceGroup key={group.id} group={group} onNavigate={onClose} />)}
      <div className="mt-2 flex items-center gap-2 px-2">
        <div className="min-w-0 flex-1"><div className="truncate text-14 font-medium">{user?.name || 'Staff'}</div>
          <div className="text-14 text-zinc-500">{user?.role === 'admin' ? 'Admin' : 'Technician'}</div></div>
        <Button variant="ghost" onClick={onLogout} aria-label="Sign out" className="shrink-0 !px-3"><LogOut size={18} aria-hidden /></Button>
      </div>
    </div>
  </UiSurface>;
}
