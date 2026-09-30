import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ['VITE_'])
  const hubProxyTarget = env.VITE_HUB_PROXY_TARGET
  return {
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: hubProxyTarget ? {
      '/api': { target: hubProxyTarget, changeOrigin: true },
      '/healthz': { target: hubProxyTarget, changeOrigin: true },
    } : undefined,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    exclude: [...configDefaults.exclude, '**/._*'],
  },
  build: {
    target: ['es2021', 'safari13'],
    minify: 'esbuild',
    sourcemap: false,
  },
  }
})
