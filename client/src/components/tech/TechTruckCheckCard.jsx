import { Link } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { lastCheckedLabel } from './useTruckKit';

// Today column card (GATE_TRUCK_KIT): shown only while a truck check is due,
// so a checked truck costs the technician nothing on the Today page.
export default function TechTruckCheckCard({ kit, base, visitSearch = '' }) {
  if (!kit?.enabled || !kit.truck || !kit.due) return null;
  const count = kit.kit?.length || 0;
  return (
    <section className="tf-card" aria-label="Truck check">
      <div className="tf-card-top"><Truck size={18} aria-hidden="true" />Truck check due</div>
      <div className="tf-card-main">
        <h2>{kit.truck.name}</h2>
        <p className="tf-muted">{lastCheckedLabel(kit.lastCheck?.checked_at)} · {count} {count === 1 ? 'item' : 'items'} on the list</p>
        <div className="tf-actions">
          <Link className="tf-button tf-primary" to={`${base}/truck-check${visitSearch}`}>Check truck</Link>
        </div>
      </div>
    </section>
  );
}
