import { defineConfig } from 'tsdown'

// Two separate builds (mirrors how DSH's own packages structure host/client):
//   lib/index.js   — host half (ESM Cordis plugin module); @deepseek-ai/*
//                    and react stay external, skill-dag inlines (it is a
//                    devDependency, so users get a zero-dep install).
//   lib/client.js  — browser half (CJS; then normalized by
//                    scripts/normalize-client-banner.mjs into the
//                    window.__ModuleLoader__.load({ id, factory }) format DSH
//                    client-modules expects — see
//                    packages/client/tsdown.client.ts in the DSH repo).
const HOST_EXTERNALS = ['@deepseek-ai/', 'react']
const CLIENT_EXTERNALS = ['@deepseek-ai/', 'react']

function isExternal(specifier: unknown, prefixes: string[]): boolean {
  if (typeof specifier !== 'string') return false
  return prefixes.some(prefix => specifier.startsWith(prefix))
}

export default defineConfig([
  {
    name: 'skill-dag-dsh',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    dts: false,
    clean: false,
    fixedExtension: false,
    outputOptions: { entryFileNames: 'index.js' },
    deps: {
      // Production deps (peerDependencies: @deepseek-ai/*) stay imports at
      // runtime — the harness provides them. Everything else (skill-dag from
      // devDependencies) inlines.
      neverBundle: (specifier: unknown) => isExternal(specifier, HOST_EXTERNALS),
      alwaysBundle: (specifier: unknown) => !isExternal(specifier, HOST_EXTERNALS),
    },
  },
  {
    name: 'skill-dag-dsh/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    fixedExtension: false,
    outputOptions: { entryFileNames: 'client.js' },
    deps: {
      // Only the loader module-table baseline (react, @deepseek-ai/*) may
      // stay as require()s; everything else inlines.
      neverBundle: (specifier: unknown) => isExternal(specifier, CLIENT_EXTERNALS),
      alwaysBundle: (specifier: unknown) => !isExternal(specifier, CLIENT_EXTERNALS),
    },
  },
])
