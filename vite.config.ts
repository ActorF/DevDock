import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
export default defineConfig({
  root: resolve(import.meta.dirname, 'renderer'),
  base: './',
  plugins: [react(), {
    name: 'devdock-development-csp',
    transformIndexHtml(html, context) {
      if (!context.server) return html
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*")
    }
  }],
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: false }
})
