import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Dev-only: forward same-origin /api to the episode server so the creator's
  // cloud buttons work under `npm run dev` with zero env config (the client
  // defaults to same-origin /api — see episodeApiUrl). No equivalent in
  // builds: prod needs its own /api route or VITE_EPISODE_API_URL.
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Buzzers',
        short_name: 'Buzzers',
        description: 'Multiplayer buzzer system for quiz games.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#06111a',
        background_color: '#06111a',
        icons: [
          { src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,gif,ico,webmanifest,txt}'],
      },
    }),
  ],
})
