import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeContext';
import './index.css';
import App from './App.tsx';

// Track the visible height: on iOS the on-screen keyboard
// shrinks only the visual viewport, so 100dvh would leave the
// terminal's bottom rows hidden behind it.
const viewport = window.visualViewport;
if (viewport) {
  const syncHeight = () => {
    document.documentElement.style.setProperty(
      '--app-height',
      `${viewport.height}px`,
    );
    // iOS scrolls the page to reveal a focused input; the
    // app is already sized to the visible area.
    if (window.scrollY) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', syncHeight);
  syncHeight();
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
