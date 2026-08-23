/**
 * Re-apply robustness test (skin switch / HMR scenario): a stale apply's
 * disposer must never clobber a newer apply's styles, window API, or handle.
 * Run: node test/reapply.test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const code = fs.readFileSync(`${root}/lib/client.cjs`, 'utf8')

// ---- id-tracking fake DOM ----
const registry = new Map()
const mkEl = () => {
  const el = {
    children: [], style: {}, dataset: {}, attrs: {}, parentNode: null, removed: false,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    hasAttribute(k) { return k in this.attrs },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { this.removed = true },
    focus() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    addEventListener() {},
    removeEventListener() {},
    get firstChild() { return this.children[0] ?? null },
    get lastElementChild() { return this.children[this.children.length - 1] ?? null },
  }
  Object.defineProperty(el, 'id', {
    get() { return el._id ?? '' },
    set(v) {
      if (el._id) registry.delete(el._id)
      el._id = String(v)
      if (el._id !== '') registry.set(el._id, el)
    },
    configurable: true,
  })
  return el
}
const document = {
  createElement: () => mkEl(),
  createTextNode: (t) => ({ nodeType: 3, nodeValue: String(t) }),
  getElementById: (id) => registry.get(id) ?? null,
  head: mkEl(), body: mkEl(), documentElement: mkEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel === '#mr-mount') return [...registry.entries()].filter(([id]) => id === 'mr-mount').map(([, el]) => el)
    return []
  },
}

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (h) => { captured = h } }, addEventListener() {}, removeEventListener() {} },
  document,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 1, clearTimeout() {},
  Promise, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, Map, Set, Symbol, WeakMap,
  encodeURIComponent, decodeURIComponent,
  MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {} },
  requestAnimationFrame: (fn) => { fn(); return 1 }, cancelAnimationFrame() {},
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] }, key() { return null }, get length() { return 0 } },
  fetch: async () => ({ ok: false, status: 404 }),
  getComputedStyle: () => ({}),
  CSS: { escape: (s) => s },
  Element: function Element() {},
  DOMParser: undefined,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.cjs' })

const fakeReact = { createElement: () => ({}), useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (fn) => fn }
const api = captured.factory((id) => {
  if (id === 'react') return fakeReact
  if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`unexpected require ${id}`)
})

const makeCtx = () => {
  let disposer = () => {}
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current: undefined, byId: {} }), subscribe: () => () => {} } },
    effect: (fn) => { disposer = fn() },
  }
  return { ctx, dispose: () => disposer() }
}

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

// Scenario 1: normal order (dispose before re-apply).
{
  const a = makeCtx()
  api.apply(a.ctx)
  const style1 = registry.get('dsh-markdown-reader-style')
  check('apply1 injects the stylesheet', style1 !== undefined && !style1.removed)
  a.dispose()
  check('dispose1 removes the stylesheet', style1.removed === true)
  check('dispose1 clears the window API', sandbox.window.dshMarkdownReader === undefined)
}

// Scenario 2: abnormal order (skin switch): apply1 → apply2 → dispose1 late.
{
  const a = makeCtx()
  const b = makeCtx()
  api.apply(a.ctx)
  const style1 = registry.get('dsh-markdown-reader-style')
  api.apply(b.ctx)
  const style2 = registry.get('dsh-markdown-reader-style')
  const theme2 = registry.get('dsh-markdown-reader-theme')
  check('apply2 re-injects the stylesheet', style2 !== undefined && style2 !== style1 && !style2.removed)
  a.dispose() // the stale disposer — must be a no-op
  check('stale dispose1 does NOT remove apply2 stylesheet', style2.removed === false)
  check('stale dispose1 does NOT remove apply2 theme sheet', theme2 !== undefined && theme2.removed === false)
  check('stale dispose1 keeps the window API', typeof sandbox.window.dshMarkdownReader === 'object' && sandbox.window.dshMarkdownReader !== null)
  b.dispose()
  check('dispose2 removes its stylesheet', style2.removed === true)
  check('dispose2 clears the window API', sandbox.window.dshMarkdownReader === undefined)
}

console.log(failed ? 'REAPPLY CHECKS FAILED' : 'ALL REAPPLY CHECKS PASS')
process.exit(failed ? 1 : 0)
