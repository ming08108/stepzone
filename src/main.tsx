import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Chakra Petch — a squared, techy display face (arcade HUD character).
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/chakra-petch/700-italic.css';
import { App } from './ui/App';
import { SettingsProvider } from './ui/SettingsContext';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
