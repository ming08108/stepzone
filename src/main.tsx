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
import './index.css';

// Controllers use the Gamepad API by default (always on, no prompt). WebHID is
// opt-in — it only initializes when you open the controller panel in Options and
// connect a raw HID pad, so it never runs or interferes at startup.

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
