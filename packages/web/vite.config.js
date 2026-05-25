import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SERVICE = 'http://localhost:5050'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/claude':        { target: SERVICE, changeOrigin: true },
      '/health':        { target: SERVICE, changeOrigin: true },
      '/search':        { target: SERVICE, changeOrigin: true },
      '/crawl':         { target: SERVICE, changeOrigin: true },
      '/jobs':          { target: SERVICE, changeOrigin: true },
      '/sessions':      { target: SERVICE, changeOrigin: true },
      '/settings':      { target: SERVICE, changeOrigin: true },
      '/embed':         { target: SERVICE, changeOrigin: true },
      '/vector-cluster':{ target: SERVICE, changeOrigin: true },
      '/resume-domain': { target: SERVICE, changeOrigin: true },
      '/congress':      { target: SERVICE, changeOrigin: true },
      '/investigate':   { target: SERVICE, changeOrigin: true },
      '/memory':        { target: SERVICE, changeOrigin: true },
    },
  },
})
