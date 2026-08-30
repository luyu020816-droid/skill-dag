import { defineConfig } from 'tsdown'

// Builds:
//   lib/index.js   — host half (ESM Cordis plugin module)
//   lib/client.js  — browser half (CJS; then normalized by
//                    scripts/normalize-client-banner.mjs into the
//                    window.__ModuleLoader__.load({ id, factory }) format DSH
//                    client-modules expects — see
//                    packages/client/tsdown.client.ts in the DSH repo).
export default defineConfig({
  entry: [
    { input: 'src/index.ts', outDir: 'lib', format: ['esm'], name: 'index' },
    { input: 'src/client/index.ts', outDir: 'lib', format: ['cjs'], name: 'client' },
  ],
  // Keep module-table modules as external requires: the browser module loader
  // resolves only the baseline set (react, @deepseek-ai/cordis, ...) plus what
  // dsh.client.inject declares.
  external: [/^@deepseek-ai\//, 'react', /^react\//],
})
