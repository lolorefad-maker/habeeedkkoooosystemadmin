import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installViewportVars } from './lib/viewport';
import './styles/index.css';

// Windows and sheets follow the visible screen (above a phone's keyboard).
installViewportVars();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
