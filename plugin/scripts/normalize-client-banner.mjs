// Normalize the tsdown CJS client bundle into the DSH lazy-CJS closure factory
// format (window.__ModuleLoader__.load({ id, factory })). Mirrors how
// dsh-market's `normalize-client-banner.mjs` wraps its tsdown output.
// Usage: node scripts/normalize-client-banner.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientPath = join(root, 'lib', 'client.js')

let body = readFileSync(clientPath, 'utf8')

// tsdown CJS output already assigns to module.exports; wrap the whole thing in
// the factory. Strip a leading 'use strict' if tsdown emitted one.
body = body.replace(/^(['"])use strict\1;\s*/, '')

const wrapped = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(pkg.name)},`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  body,
  `\t\treturn module.exports;`,
  `\t}`,
  `});`,
].join('\n')

writeFileSync(clientPath, wrapped)
console.log(`[skill-dag-dsh] normalized ${clientPath} (${wrapped.length} bytes)`)
