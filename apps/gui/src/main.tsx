import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './connected-devices.css';
import './automation.css';

const element = document.getElementById('root');
if (!element) throw new Error('Missing application root.');
createRoot(element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import './settings.css';
import './motion.css';
