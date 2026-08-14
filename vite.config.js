import { defineConfig, loadEnv } from 'vite'
import { chatPlugin } from './server.mjs'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.GITHUB_PAGES_BASE || '/',
    server: { port: 5173 },
    plugins: [chatPlugin({ env })],
  }
})
