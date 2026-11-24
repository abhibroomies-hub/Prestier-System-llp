import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(projectRoot, 'index.html');

if (!fs.existsSync(indexHtmlPath) || fs.statSync(indexHtmlPath).size === 0) {
  fs.writeFileSync(
    indexHtmlPath,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prestier System LLP — Lead Capture & Live Sheet Portal</title>
    <meta name="description" content="Real-time steel manufacturing lead capture portal for Prestier System LLP with automatic partial lead capture, live Google Sheets sync, Firebase Firestore persistence, and 24/7 persistent WhatsApp automation." />
    <meta property="og:title" content="Prestier System LLP — Lead Capture & Live Sheet Portal" />
    <meta property="og:description" content="Real-time steel manufacturing lead capture portal for Prestier System LLP with automatic partial lead capture, live Google Sheets sync, Firebase Firestore persistence, and 24/7 persistent WhatsApp automation." />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet" />
  </head>
  <body class="bg-slate-900 text-slate-900 antialiased selection:bg-sky-500/30 selection:text-sky-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    'utf8'
  );
}

export default defineConfig({
  root: projectRoot,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'copy-unbundled-src-assets',
      closeBundle() {
        const srcAssetsDir = path.join(projectRoot, 'src/assets');
        const destAssetsDir = path.join(projectRoot, 'dist/src/assets');
        if (fs.existsSync(srcAssetsDir)) {
          fs.cpSync(srcAssetsDir, destAssetsDir, { recursive: true });
        }
      },
    },
  ],
  build: {
    outDir: path.join(projectRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: indexHtmlPath,
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    hmr: false,
  },
});
