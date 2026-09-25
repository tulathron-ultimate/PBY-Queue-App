import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PBY Queue',
        short_name: 'PBY Queue',
        description: 'Photo line queue for Photos by Yaz',
        theme_color: '#545E40',
        background_color: '#EFEDE8',
        display: 'standalone',
        start_url: '/host',
        scope: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//, /^\/sms\//, /^\/healthz/],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/sms': api,
      '/healthz': api,
      '/ws': { target: api, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
