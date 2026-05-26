import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, XCircle, DollarSign } from 'lucide-react';

export default function QuickActionMenu({ service, onReschedule, onCancel, onMarkPrepaid, onClose, isMobile = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('pointerdown', handle, true);
    return () => document.removeEventListener('pointerdown', handle, true);
  }, [onClose]);

  useEffect(() => {
    const handle = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const btnClass = 'flex items-center gap-3 w-full text-left px-4 py-3 text-14 text-zinc-900 hover:bg-zinc-50 active:bg-zinc-100';

  const content = (
    <div ref={ref}>
      {isMobile && (
        <div className="fixed inset-0 bg-black/30 z-[9998]" onClick={onClose} />
      )}
      <div
        className={
          isMobile
            ? 'fixed bottom-0 left-0 right-0 bg-white rounded-t-xl z-[9999] pb-safe'
            : 'absolute bg-white border-hairline border-zinc-300 rounded-sm shadow-lg z-[9999] min-w-[200px]'
        }
        style={isMobile ? { paddingBottom: 'max(16px, env(safe-area-inset-bottom))' } : {}}
      >
        {isMobile && (
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-10 h-1 rounded-full bg-zinc-300" />
          </div>
        )}
        <div className="px-4 py-2 text-12 text-zinc-500 uppercase tracking-label font-medium border-b border-hairline border-zinc-100">
          {service?.customerName || 'Appointment'}
        </div>
        {onReschedule && (
          <button type="button" className={btnClass} onClick={() => { onReschedule(service); onClose(); }}>
            <CalendarDays size={18} strokeWidth={1.5} className="text-zinc-500" />
            Reschedule
          </button>
        )}
        {onCancel && service?.status !== 'completed' && service?.status !== 'cancelled' && (
          <button type="button" className={btnClass} onClick={() => { onCancel(service); onClose(); }}>
            <XCircle size={18} strokeWidth={1.5} className="text-zinc-500" />
            Cancel appointment
          </button>
        )}
        {onMarkPrepaid && (!service?.prepaidAmount || Number(service.prepaidAmount) <= 0) && (
          <button type="button" className={btnClass} onClick={() => { onMarkPrepaid(service); onClose(); }}>
            <DollarSign size={18} strokeWidth={1.5} className="text-zinc-500" />
            Mark prepaid
          </button>
        )}
        {isMobile && (
          <button type="button" className="w-full text-center py-3 text-14 text-zinc-500 font-medium border-t border-hairline border-zinc-200" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );

  return isMobile ? createPortal(content, document.body) : content;
}
