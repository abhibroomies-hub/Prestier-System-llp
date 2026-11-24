import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, '..');

const INDEX_HTML_FALLBACK = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prestier System LLP — Lead Capture & Live Sheet Portal</title>
    <meta
      name="description"
      content="Real-time steel manufacturing lead capture portal for Prestier System LLP with automatic partial lead capture, live Google Sheets sync, Firebase Firestore persistence, and 24/7 persistent WhatsApp automation."
    />
    <meta property="og:title" content="Prestier System LLP — Lead Capture & Live Sheet Portal" />
    <meta
      property="og:description"
      content="Real-time steel manufacturing lead capture portal for Prestier System LLP with automatic partial lead capture, live Google Sheets sync, Firebase Firestore persistence, and 24/7 persistent WhatsApp automation."
    />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap"
      rel="stylesheet"
    />
  </head>
  <body class="bg-slate-900 text-slate-900 antialiased selection:bg-sky-500/30 selection:text-sky-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const MAIN_TSX_FALLBACK = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

function ensureNonEmptyFile(relPath, fallbackContent) {
  const fullPath = path.join(projectRoot, relPath);
  const exists = fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
  if (!exists) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, fallbackContent, 'utf8');
    console.log(`[ensure-entry] Restored missing ${relPath}`);
  }
}

ensureNonEmptyFile('index.html', INDEX_HTML_FALLBACK);
ensureNonEmptyFile('src/main.tsx', MAIN_TSX_FALLBACK);
ensureNonEmptyFile('src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
