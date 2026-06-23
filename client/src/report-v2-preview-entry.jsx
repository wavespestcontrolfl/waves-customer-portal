// Standalone dev entry for the Lawn Report V2 visual preview. Mounts the preview
// page directly (no App.jsx / router / BiometricGate / Capacitor), so the visuals
// can be iterated in Chrome DevTools without the full app or its native deps.
import { createRoot } from 'react-dom/client';
import LawnReportV2Preview from './pages/LawnReportV2Preview';

createRoot(document.getElementById('root')).render(<LawnReportV2Preview />);
