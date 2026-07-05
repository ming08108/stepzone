import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Chakra Petch — a squared, techy display face (arcade HUD character).
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/chakra-petch/700-italic.css';
// Space Grotesk — the STEPLINE handoff typeface (song select).
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { SettingsProvider } from './ui/SettingsContext';
import './index.css';

// Controllers use the Gamepad API (always on, no prompt) alongside the
// keyboard; see src/input/. There is no raw-HID path today — WebHID is a
// possible future addition (docs/ROADMAP.md).

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ErrorBoundary>
  </StrictMode>,
);
