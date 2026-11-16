import React from 'react';
import ReactDOM from 'react-dom/client';
import '@jetbrains/ring-ui-built/components/style.css';

import {App} from './app';
import './app.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App/>
  </React.StrictMode>
);
