import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/app.css';

// The page itself never scrolls: the map runs on under the browser's bars
// (see .map), so the document is a little taller than the window, and
// overflow: hidden doesn't stop the browser scrolling it to reveal a focused
// element. Undo any such scroll so the header and panels stay put.
window.addEventListener(
  'scroll',
  () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  },
  { passive: true },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
