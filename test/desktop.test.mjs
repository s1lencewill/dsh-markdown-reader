import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const { installReaderTitlebarInset } = createRequire(import.meta.url)('../lib/client.cjs')

test('desktop overlays follow native titlebars, fullscreen and lifecycle cleanup', () => {
  const oldObserver = globalThis.MutationObserver
  let mutation
  let disconnected = false
  globalThis.MutationObserver = class {
    constructor(fn) { mutation = fn }
    observe() {}
    disconnect() { disconnected = true }
  }
  try {
    const events = new Map()
    const nativeEvents = new Map()
    const overlay = {
      visible: false,
      getTitlebarAreaRect: () => ({ y: 0, height: 48 }),
      addEventListener: (key, fn) => nativeEvents.set(key, fn),
      removeEventListener: (key) => nativeEvents.delete(key),
    }
    const win = {
      navigator: { userAgent: 'Chrome/140 Electron/38', windowControlsOverlay: overlay },
      addEventListener: (key, fn) => events.set(key, fn),
      removeEventListener: (key) => events.delete(key),
    }
    let chrome = null
    let inset
    const doc = {
      defaultView: win, body: {}, fullscreenElement: null,
      documentElement: { hasAttribute: () => false },
      getElementById: () => chrome,
      addEventListener: (key, fn) => events.set(key, fn),
      removeEventListener: (key) => events.delete(key),
    }
    const dispose = installReaderTitlebarInset({ ownerDocument: doc, style: { setProperty: (_, v) => { inset = v } } })
    assert.equal(inset, '36px')
    chrome = { getBoundingClientRect: () => ({ width: 900, height: 40, bottom: 40 }) }
    mutation()
    assert.equal(inset, '40px')
    chrome = null
    overlay.visible = true
    nativeEvents.get('geometrychange')()
    assert.equal(inset, '48px')
    overlay.visible = false
    doc.fullscreenElement = {}
    events.get('fullscreenchange')()
    assert.equal(inset, '0px')
    doc.fullscreenElement = null
    win.navigator.userAgent = 'Chrome/140'
    events.get('resize')()
    assert.equal(inset, '0px', 'ordinary browser keeps its full viewport')
    dispose()
    assert.equal(events.size, 0)
    assert.equal(nativeEvents.size, 0)
    assert(disconnected)
  } finally {
    globalThis.MutationObserver = oldObserver
  }
})
