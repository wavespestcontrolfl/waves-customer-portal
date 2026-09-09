import { useEffect, useRef, useState } from 'react';
import { Pin, Sparkles, X } from 'lucide-react';
import { Button, Dialog, DialogHeader, DialogTitle, Input, UiSurface } from '../ui';
import useAdminNavigation from '../../hooks/useAdminNavigation';
import { searchAdminWorkspacePages } from '../../config/adminNavigation';
import { WorkspaceLink } from './AdminWorkspaceNavigation';

export default function AdminPageFinder({ onClose, onAsk, onNavigate }) {
  const { groups, pinnedItems, togglePin } = useAdminNavigation();
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const results = searchAdminWorkspacePages(groups, query);
  if (!query.trim()) results.sort((a, b) => Number(pinnedItems.some((item) => item.id === b.id)) - Number(pinnedItems.some((item) => item.id === a.id)));
  const links = () => Array.from(resultsRef.current?.querySelectorAll('a') || []);
  return <UiSurface density="comfortable">
    <Dialog open onClose={onClose} layer={9999} className="h-full sm:max-h-[680px]"
      style={{ top: 'var(--vv-offset-top, 0px)', bottom: 'auto', height: 'calc(var(--admin-vh, 100%) - var(--vv-offset-top, 0px))' }}>
      <DialogHeader>
        <div className="mb-3 flex items-center justify-between gap-3">
          <DialogTitle>Go to a page</DialogTitle>
          <Button variant="ghost" onClick={onClose} aria-label="Close page search" className="!px-3"><X size={18} aria-hidden /></Button>
        </div>
        <Input ref={inputRef} type="search" aria-label="Search pages" placeholder="Search pages or old names…" value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); links()[0]?.focus(); }
            if (event.key === 'Enter') { event.preventDefault(); links()[0]?.click(); }
          }} />
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {results.length === 0 && <p role="status" className="px-2 text-14 text-zinc-500">No pages match “{query}”. Try a page or workspace name.</p>}
        <ul ref={resultsRef} aria-label="Pages" className="m-0 list-none p-0" onKeyDown={(event) => {
          const index = links().indexOf(event.target);
          if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const targets = links();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length;
          targets[next]?.focus();
        }}>
          {results.map((item) => {
            const pinned = pinnedItems.some((pin) => pin.id === item.id);
            const Icon = item.icon;
            return <li key={item.id} className="flex items-center gap-1">
              <WorkspaceLink item={item} source="palette" className="!py-2" onNavigate={() => { onClose(); onNavigate?.(); }}>
                <Icon size={18} className="shrink-0" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block text-14 font-medium">{item.label}</span><span className="block text-14 font-normal text-zinc-500">{item.groupLabel}</span></span>
              </WorkspaceLink>
              <Button variant="ghost" className="shrink-0 !px-3" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${item.label}`} aria-pressed={pinned}
                disabled={!pinned && pinnedItems.length >= 3} onClick={() => togglePin(item.id)} title={!pinned && pinnedItems.length >= 3 ? 'Unpin a page to add another' : undefined}>
                <Pin size={18} aria-hidden fill={pinned ? 'currentColor' : 'none'} />
              </Button>
            </li>;
          })}
        </ul>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3">
        <span role="status" className="text-14 text-zinc-500">{pinnedItems.length} of 3 pinned</span>
        <Button variant="ghost" onClick={onAsk}><Sparkles size={18} aria-hidden />Ask Waves</Button>
      </div>
    </Dialog>
  </UiSurface>;
}
