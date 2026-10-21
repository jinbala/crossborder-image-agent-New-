import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import LocaleProvider from './i18n/LocaleProvider.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LocaleProvider><BrowserRouter>
      <AuthGate><App /></AuthGate>
    </BrowserRouter></LocaleProvider>
  </React.StrictMode>
);
