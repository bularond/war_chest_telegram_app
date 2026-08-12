import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { store } from './net.js';
import { initTelegram } from './telegram.js';
import './ui/styles.css';

initTelegram();
store.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
