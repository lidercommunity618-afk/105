/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Trading Terminal',
        short_name: 'Terminal',
        description: 'Real-time crypto & forex trading terminal with technical analysis',
        theme_color: '#0a0e17',
        background_color: '#0a0e17',
        display: 'standalone',
        // Аудит (переворот экрана): раньше 'portrait' — в установленном
        // PWA (display: 'standalone') Android/Chromium применяет это как
        // жёсткий lock ориентации на уровне ОС и игнорирует любую
        // JS/CSS-адаптацию (useLandscape.ts, LandscapeControls.tsx уже
        // умели работать в landscape, но переворот до них просто не
        // долетал). 'any' снимает лок — приложение поворачивается вместе
        // с устройством, а существующая portrait/landscape-раскладка
        // (App.tsx) отрабатывает как и раньше, в обычной вкладке браузера
        // это поле никогда не действовало.
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Аудит, п.7 (offline): Google Fonts подключены внешним <link> в
        // index.html (fonts.googleapis.com/fonts.gstatic.com) и не входят в
        // globPatterns выше (тот кэширует только собственные ассеты сборки),
        // поэтому при плохой сети/офлайн шрифты не подтягивались — FOUT/
        // откат на системный шрифт. Явные runtimeCaching-правила покрывают
        // оба хоста тем же способом, что рекомендует сам vite-plugin-pwa для
        // Google Fonts.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 год — файлы шрифтов по URL неизменны
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      output: {
        // Аудит, п.5 (performance): раньше весь код (включая
        // lightweight-charts и @sentry/react — два самых тяжёлых пакета в
        // зависимостях) собирался в один основной чанк ~846 KB (243 KB
        // gzip), что превышало предупреждающий порог Vite в 500 KB и
        // задерживало первую загрузку на мобильной сети. manualChunks
        // выносит их в отдельные файлы: браузер грузит их параллельно с
        // основным чанком (а не последовательно внутри одного файла), и
        // они кэшируются отдельно от часто меняющегося кода приложения.
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('lightweight-charts')) return 'vendor-charts';
            if (id.includes('@sentry')) return 'vendor-sentry';
            if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
            if (id.includes('zod')) return 'vendor-zod';
            if (id.includes('zustand')) return 'vendor-zustand';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'backtest/**/*.test.ts'],
  },
});
