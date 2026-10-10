// Real browser regression for asset failures and overlapping client generations.
// Requires Playwright (dev only); optional KATEX_TEST_DOCUMENT and KATEX_TEST_SCREENSHOT.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, extname, sep } from 'node:path'

const { chromium } = createRequire(import.meta.url)('playwright')
const root = fileURLToPath(new URL('..', import.meta.url))
const code = await readFile(resolve(root, 'lib/client.cjs'), 'utf8')
const bundle = `(function(){${code}\nwindow.mathEngine = { ensureKatex, renderDocument, katexReadyListeners, READER_CSS };})()`
const formula = String.raw`# Formula regression

Inline $\vec{f}_i=-\frac{\partial E}{\partial r_i}$ and $\langle q,k\rangle$.

$$L=\frac{1}{N}\sum_{k=1}^{N}\Big(\alpha_E\big(E_k^\text{DFT}-E_k^\text{NN}\big)^2+\alpha_f\|\vec{f}_k^\text{DFT}-\vec{f}_k^\text{NN}\|^2\Big)$$

Code stays code: \`$x$\`. Currency stays text: $5 and $10.`.replaceAll('\\`', '`')
let jsFailures = 1, cssFailures = 1, jsRequests = 0, hold = false, release
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><html><head></head><body><article class="mr-doc"></article></body></html>')
      return
    }
    if (req.url.endsWith('/katex.min.js')) {
      jsRequests++
      if (jsFailures-- > 0) { res.writeHead(503); res.end('temporarily unavailable'); return }
      if (hold) await new Promise(resolve => { release = resolve })
    }
    if (req.url.endsWith('/katex.min.css') && cssFailures-- > 0) { res.writeHead(503); res.end(); return }
    const file = resolve(root, 'vendor', req.url.replace('/md-reader/assets/', ''))
    if (!file.startsWith(root + (root.endsWith(sep) ? '' : sep))) throw new Error('outside root')
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const origin = `http://127.0.0.1:${server.address().port}`
async function open() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  await page.goto(origin)
  await page.addScriptTag({ content: bundle })
  await page.evaluate(source => {
    window.source = source
    window.draw = () => { document.querySelector('article').innerHTML = mathEngine.renderDocument(source, { root: '/w', mdPath: 'example.md' }).html }
    mathEngine.katexReadyListeners.add(window.draw)
    window.draw()
  }, formula)
  return page
}
try {
  const first = await open()
  await first.waitForFunction(() => document.querySelector('.katex') && !document.querySelector('.mr-math-pending'))
  assert.equal(jsRequests, 2, '503 should automatically retry')
  assert.equal(await first.locator('.katex-error').count(), 0)
  assert(await first.locator('article').innerText().then(text => text.includes('$5 and $10')))
  assert.equal(await first.locator('code').innerText(), '$x$')
  console.log('PASS: failed JS/CSS requests recover and replace pending formulas.')

  hold = true
  const overlapping = await open()
  await overlapping.evaluate(() => mathEngine.katexReadyListeners.delete(window.draw))
  await overlapping.addScriptTag({ content: bundle })
  await overlapping.evaluate(() => {
    window.newGenerationNotifications = 0
    mathEngine.katexReadyListeners.add(() => { newGenerationNotifications++; window.draw() })
  })
  assert.equal(await overlapping.locator('.mr-math-pending').count(), 3)
  assert.equal(typeof release, 'function')
  hold = false; release()
  await overlapping.waitForFunction(() => newGenerationNotifications === 1 && !document.querySelector('.mr-math-pending'))
  assert.equal(jsRequests, 3, 'overlapping bundles share one in-flight request')
  console.log('PASS: a newer client generation receives the older in-flight load notification.')

  jsFailures = 100
  const failed = await open()
  assert.equal(await failed.evaluate(() => mathEngine.ensureKatex()), null)
  assert.equal(await failed.locator('.mr-math-pending').count(), 3)
  jsFailures = 0
  await failed.evaluate(() => mathEngine.ensureKatex())
  assert.equal(await failed.locator('.mr-math-pending').count(), 0)
  await failed.evaluate(async () => {
    document.querySelector('link[href*="katex.min.css"]').remove()
    await mathEngine.ensureKatex()
  })
  assert(await failed.locator('link[href*="katex.min.css"]').evaluate(el => !!el.sheet))
  console.log('PASS: exhausted retries can restart, and removed stylesheets are restored.')

  if (process.env.KATEX_TEST_DOCUMENT) {
    const source = await readFile(process.env.KATEX_TEST_DOCUMENT, 'utf8')
    const result = await first.evaluate(source => {
      document.querySelector('article').innerHTML = mathEngine.renderDocument(source, { root: '/w', mdPath: 'example.md' }).html
      return { pending: document.querySelectorAll('.mr-math-pending').length, errors: document.querySelectorAll('.katex-error').length, formulas: document.querySelectorAll('.katex').length }
    }, source)
    assert.equal(result.pending, 0); assert.equal(result.errors, 0); assert(result.formulas > 0)
    console.log(`PASS: supplied document renders ${result.formulas} formulas without pending/error nodes.`)
    if (process.env.KATEX_TEST_SCREENSHOT) {
      await first.evaluate(source => {
        const style = document.createElement('style'); style.textContent = mathEngine.READER_CSS + '.mr-doc { margin: 24px; padding: 24px; background: #f7f9fc; color: #263447; }'; document.head.append(style)
        document.querySelector('article').innerHTML = mathEngine.renderDocument(source.split('\n').slice(95, 118).join('\n'), { root: '/w', mdPath: 'example.md' }).html
      }, source)
      await first.evaluate(() => document.fonts.ready)
      await first.screenshot({ path: process.env.KATEX_TEST_SCREENSHOT, fullPage: true })
    }
  }
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
