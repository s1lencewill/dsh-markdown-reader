import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { PRINT_CSS, waitForPrintTask } = require('../lib/client.cjs')

test('print task returns readiness and propagates errors', async () => {
  assert.equal(await waitForPrintTask(Promise.resolve(true)), true)
  await assert.rejects(waitForPrintTask(Promise.reject(new Error('load failed'))), /load failed/)
})

test('print task times out rather than waiting indefinitely for resources', async () => {
  assert.equal(await waitForPrintTask(new Promise(() => {}), undefined, 5), false)
})

test('print task aborts while preparing and when already cancelled', async () => {
  const controller = new AbortController()
  const task = waitForPrintTask(new Promise(() => {}), controller.signal)
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
  await assert.rejects(waitForPrintTask(Promise.resolve(true), controller.signal), { name: 'AbortError' })
})

test('print stylesheet supports pagination without fixed scroll containers', () => {
  assert.match(PRINT_CSS, /@page\s*\{[^}]*size: auto/)
  assert.match(PRINT_CSS, /thead\s*\{\s*display: table-header-group/)
  assert.match(PRINT_CSS, /\.mr-code-wrap, \.mr-table-wrap\s*\{[^}]*overflow: visible; max-height: none/)
  assert.match(PRINT_CSS, /pre\s*\{[^}]*white-space: pre-wrap[^}]*break-inside: auto/)
  assert.doesNotMatch(PRINT_CSS, /position:\s*fixed|overflow:\s*hidden|100vh/)
})
