// Standalone dev entry for the tech "capture for recap" flow preview (no App.jsx /
// router / BiometricGate / Capacitor), so the tech-side UX can be tapped through in
// the browser without the full app or its native deps.
import { createRoot } from 'react-dom/client';
import TechCapturePreview from './pages/TechCapturePreview';

createRoot(document.getElementById('root')).render(<TechCapturePreview />);
