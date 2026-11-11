import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/theme.css';
import './ui/styles/shell.css';
import './ui/styles/viewer.css';
import './ui/styles/features.css';
import './ui/styles/organizer.css';
import './ui/styles/combine.css';
import './ui/styles/menubar.css';
import './ui/styles/toolbar.css';
import { App } from './app/App';
import { bootApp } from './app/boot';

bootApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
