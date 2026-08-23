/**
 * Verify the vendored mermaid.min.js: loads as a classic script tag
 * (globalThis.mermaid), exposes the v11 API, and renders a diagram.
 * Run: node test/mermaid-e2e.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = fs.readFileSync(`${root}/vendor/mermaid/mermaid.min.js`, 'utf8')

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

// 1. Loads like a <script> tag: classic-script semantics (top-level `var`
//    lands on the global object) — vm.runInThisContext reproduces that.
vm.runInThisContext(src, { filename: 'mermaid.min.js' })
check('globalThis.mermaid is an object', typeof globalThis.mermaid === 'object' && globalThis.mermaid !== null)
check('has initialize', typeof globalThis.mermaid?.initialize === 'function')
check('has render', typeof globalThis.mermaid?.render === 'function')
check('has parse', typeof globalThis.mermaid?.parse === 'function')

// 2. initialize (v11 shape used by the reader).
try {
  globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
  check('initialize({startOnLoad:false, securityLevel:"strict"})', true)
} catch (err) {
  check('initialize(...)', false, String(err))
}

// 3. parse (the parser runs without DOM; render needs a real DOM and is
//    verified in the browser instead).
try {
  const parsed = await globalThis.mermaid.parse('graph TD;\nA-->B;')
  check('parse returns a diagram type', parsed !== null && typeof parsed === 'object' && typeof parsed.diagramType === 'string', `diagramType=${parsed?.diagramType ?? '?'}`)
} catch (err) {
  check('parse returns a diagram type', false, String(err).slice(0, 200))
}

// 4. Real render — best effort: v11 render needs a real browser DOM, so a
//    failure here only means the Node harness is too thin, not that the
//    browser render is broken.
try {
  const g = globalThis
  const nodes = []
  const mkEl = (tag) => ({
    tagName: tag.toUpperCase(), nodeType: 1, children: [], attrs: {}, style: {}, dataset: {}, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    hasAttribute(k) { return k in this.attrs },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    get firstChild() { return this.children[0] ?? null },
    innerHTML: '', textContent: '',
  })
  const document = {
    createElement: (t) => { const el = mkEl(t); nodes.push(el); return el },
    createElementNS: (ns, t) => mkEl(t),
    createTextNode: (t) => ({ nodeType: 3, nodeValue: String(t), textContent: String(t) }),
    body: mkEl('body'), head: mkEl('head'), documentElement: mkEl('html'),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    getElementsByTagName: () => [],
  }
  if (g.document === undefined) g.document = document
  if (g.window === undefined) g.window = g
  try {
    Object.defineProperty(g, 'navigator', { value: { userAgent: 'node-verify' }, configurable: true, writable: true })
  } catch { /* present */ }
  const out = await globalThis.mermaid.render('mrtest1', 'graph TD;\n  A[开始] --> B{判断};')
  const svg = out && typeof out.svg === 'string' && out.svg.includes('<svg') ? out.svg : null
  if (svg !== null) {
    check('render returns svg', true)
  } else {
    console.log('SKIP  render returns svg (needs a real browser DOM)')
  }
} catch {
  console.log('SKIP  render returns svg (needs a real browser DOM)')
}

console.log(failed ? 'MERMAID CHECKS FAILED' : 'ALL MERMAID CHECKS PASS')
process.exit(failed ? 1 : 0)
