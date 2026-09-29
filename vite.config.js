import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

// Surface package.json's version to the renderer so it can never drift from the
// release (used by the onboarding "what's new" copy and the update check).
const pkg = createRequire(import.meta.url)('./package.json')

// https://vite.dev/config/
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
})
