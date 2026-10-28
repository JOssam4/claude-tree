import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// The Electron shell hides the native title bar on macOS; .mac-shell styles
// make room for the traffic lights and add a window drag region.
if (navigator.userAgent.includes('Electron') && navigator.userAgent.includes('Mac')) {
  document.documentElement.classList.add('mac-shell');
}

const rootEl =document.getElementById('root');
if (!rootEl) {
    throw new Error('#root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
