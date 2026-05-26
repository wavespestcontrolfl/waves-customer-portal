import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function InlineTechPicker({ serviceId, currentTechId, technicians = [], onAssigned, onClose, anchorRect }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('pointerdown', handle, true);
    return () => document.removeEventListener('pointerdown', handle, true);
  }, [onClose]);

  const assign = async (techId) => {
    setBusy(true);
    try {
      const token = localStorage.getItem('waves_admin_token');
      const res = await fetch(`${API_BASE}/admin/schedule/${serviceId}/assign`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId: techId || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onAssigned?.(techId);
    } catch (e) {
      console.error('Assign failed:', e);
    }
    setBusy(false);
    onClose();
  };

  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 4,
    left: anchorRect.left,
    zIndex: 9999,
  } : {
    position: 'absolute',
    top: '100%',
    left: 0,
    zIndex: 9999,
  };

  const picker = (
    <div
      ref={ref}
      className="bg-white border-hairline border-zinc-300 rounded-sm shadow-lg overflow-hidden"
      style={{ ...style, minWidth: 160, maxHeight: 240, overflowY: 'auto' }}
    >
      <button
        type="button"
        onClick={() => assign(null)}
        disabled={busy || !currentTechId}
        className="w-full text-left px-3 py-2 text-12 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 border-b border-hairline border-zinc-100"
      >
        Unassign
      </button>
      {technicians.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => assign(t.id)}
          disabled={busy || t.id === currentTechId}
          className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 disabled:bg-zinc-50 disabled:text-zinc-400 border-b border-hairline border-zinc-50"
        >
          {t.name}
          {t.id === currentTechId && <span className="ml-1 text-11 text-zinc-400">(current)</span>}
        </button>
      ))}
      {technicians.length === 0 && (
        <div className="px-3 py-2 text-12 text-zinc-400">No technicians available</div>
      )}
    </div>
  );

  return anchorRect ? createPortal(picker, document.body) : picker;
}
