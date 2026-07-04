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
import { SettingsProvider } from './ui/SettingsContext';
import { initWebHid } from './input/webhid';
import './index.css';

// Re-open any WebHID dance pad the user already granted, and listen for hot-plug.
// No-op (and never throws) when WebHID is unavailable.
initWebHid();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
