import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));

const params = new URLSearchParams(window.location.search);
if (params.get('overlay') === '1') {
  const SearchOverlay = React.lazy(() => import('./components/SearchOverlay'));
  root.render(
    <React.Suspense fallback={null}>
      <SearchOverlay />
    </React.Suspense>
  );
} else if (params.get('fillin') === '1') {
  const FillInWindow = React.lazy(() => import('./components/FillInWindow'));
  root.render(
    <React.Suspense fallback={null}>
      <FillInWindow />
    </React.Suspense>
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
