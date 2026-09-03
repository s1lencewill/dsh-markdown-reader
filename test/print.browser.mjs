/** Optional real Chromium print regression. Requires Playwright (dev only).
 * PRINT_BROWSER_CHANNEL=msedge (default), or PRINT_BROWSER_EXECUTABLE=/path/to/chromium.
 * PRINT_TEST_OUTPUT chooses where test PDFs are written; default tmp/pdfs.
 * Browser print UI is intercepted; PDF layout is verified with the same print snapshot.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.env.PRINT_TEST_OUTPUT || resolve(root, 'tmp/pdfs'))
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><html lang="zh-CN"><head><title>DSH shell</title></head><body><button id="focus">DSH_PRIVATE_SHELL</button><div id="mr-root"><article class="mr-doc"></article></div></body></html>')
      return
    }
    if (url.pathname === '/md-reader/raw') {
      if (!url.searchParams.get('path')?.endsWith('figure.svg')) { res.writeHead(404); res.end(); return }
      res.setHeader('content-type', 'image/svg+xml')
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220" viewBox="0 0 900 220"><rect width="900" height="220" fill="#eff6ff"/><path d="M40 180 L200 130 L400 160 L600 60 L860 40" fill="none" stroke="#1565c0" stroke-width="5"/><text x="40" y="35" font-size="24">Print figure - vector image</text></svg>')
      return
    }
    const relative = url.pathname.startsWith('/md-reader/assets/')
      ? `vendor/${url.pathname.slice('/md-reader/assets/'.length)}` : url.pathname.slice(1)
    const path = resolve(root, relative)
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('outside root')
    const mime = { '.cjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
    res.setHeader('content-type', mime[extname(path)] || 'application/octet-stream')
    res.end(await readFile(path))
  } catch { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PRINT_BROWSER_EXECUTABLE
    ? { executablePath: process.env.PRINT_BROWSER_EXECUTABLE }
    : { channel: process.env.PRINT_BROWSER_CHANNEL || 'msedge' }) })
  const page = await browser.newPage()
  await page.goto(origin)
  await page.evaluate(() => { window.module = { exports: {} } })
  await page.addScriptTag({ url: `${origin}/lib/client.cjs` })
  await page.addStyleTag({ url: `${origin}/md-reader/assets/katex/katex.min.css` })
  await page.addScriptTag({ url: `${origin}/md-reader/assets/katex/katex.min.js` })
  await page.addScriptTag({ url: `${origin}/md-reader/assets/mermaid/mermaid.min.js` })
  const fixture = [
    '# 打印与 PDF 测试 / Print regression',
    '中文正文、English prose、**粗体**和[外部链接](https://example.com)。',
    '## 折叠章节 / Collapsed section',
    'COLLAPSED_CONTENT_SENTINEL ' + '这是折叠章节内也必须打印的正文。'.repeat(70),
    '$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$',
    '行内公式 $E=mc^2$，以及公式后面的中文文字。',
    '![Vector figure](figure.svg)',
    '![Missing image](missing.png)',
    '```mermaid\nflowchart LR\n  A[Markdown] --> B[Print snapshot] --> C[PDF]\n```',
    '## 跨页表格 / Multi-page table',
    '| Row | 参数 Parameter | 说明 Description |\n| --- | --- | --- |\n' + Array.from({ length: 65 }, (_, i) => `| ${i + 1} | $k_${i}=10^{-3}$ | 表格数据 Table row ${i + 1} |`).join('\n'),
    '## 长代码 / Long code',
    '```js\n' + Array.from({ length: 95 }, (_, i) => `const row${i} = "line ${i} must survive page breaks";`).join('\n') + '\n// ' + 'UNBROKEN_'.repeat(50) + '\n```',
    '## 文档结束 / End',
    'END_OF_DOCUMENT_SENTINEL',
  ].join('\n\n')
  await page.evaluate((fixture) => {
    detectLang()
    const style = document.createElement('style')
    style.textContent = READER_CSS
    document.head.appendChild(style)
    const article = document.querySelector('.mr-doc')
    article.innerHTML = renderDocument(fixture, { root: '/workspace', mdPath: 'docs/test.md' }).html
    decorateReaderDocument(article)
    window.printFixture = fixture
    // Intercept only the dialog; all production preparation/cleanup code still runs.
    window.dialogCount = 0
    window.printObserver = new MutationObserver(() => {
      const frame = document.querySelector('.mr-print-frame')
      if (!frame || frame.dataset.hooked) return
      frame.dataset.hooked = 'true'
      frame.contentWindow.print = () => {
        window.dialogCount += 1
        frame.contentWindow.dispatchEvent(new Event('beforeprint'))
        window.capturedPrint = frame.contentDocument.documentElement.outerHTML
        setTimeout(() => frame.contentWindow?.dispatchEvent(new Event('afterprint')), 20)
      }
    })
    window.printObserver.observe(document.body, { childList: true })
  }, fixture)
  await mkdir(output, { recursive: true })
  for (const dark of [false, true]) {
    await page.evaluate(async (dark) => {
      document.body.toggleAttribute('data-ds-dark-theme', dark)
      const article = document.querySelector('.mr-doc')
      await renderMermaidIn(article, 'Mermaid unavailable')
      for (const button of article.querySelectorAll('.mr-section-toggle')) {
        for (const node of button.__mrSectionNodes) node.hidden = true
        button.setAttribute('aria-expanded', 'false')
      }
      for (const wrapper of article.querySelectorAll('.mr-code-wrap')) wrapper.classList.add('mr-code-collapsed')
    }, dark)
    const before = await page.locator('.mr-doc').evaluate((el) => el.outerHTML)
    await page.locator('#focus').focus()
    await page.evaluate(async () => {
      await printReaderDocument(document.querySelector('.mr-doc'), { title: '打印测试', path: 'docs/print-test.md', truncated: true }, new AbortController().signal)
    })
    assert.equal(await page.locator('.mr-print-frame').count(), 0, 'print frame cleaned after closing dialog')
    assert.equal(await page.locator('.mr-doc').evaluate((el) => el.outerHTML), before, 'live DOM must be unchanged')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'focus', 'focus restored')
    const html = await page.evaluate(() => window.capturedPrint)
    assert(!html.includes('DSH_PRIVATE_SHELL'), 'host chrome is excluded')
    assert(!html.includes('class="mr-section-toggle"'), 'section controls excluded')
    assert(!html.includes('data-line='), 'line numbers removed without losing newlines')
    assert(!html.includes(' hidden'), 'collapsed sections expanded')
    assert(html.includes('COLLAPSED_CONTENT_SENTINEL'))
    assert(html.includes('END_OF_DOCUMENT_SENTINEL'))
    assert(html.includes('原文件超过读取上限'))
    assert(html.includes('图片未能加载'))
    assert(html.includes('mr-mermaid-render'))
    const printPage = await browser.newPage({ viewport: { width: 688, height: 900 } })
    await printPage.setContent(html, { waitUntil: 'networkidle' })
    await printPage.evaluate(() => document.fonts.ready)
    const overflow = await printPage.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }))
    assert(overflow.body <= overflow.viewport + 2, `horizontal clipping: ${JSON.stringify(overflow)}`)
    await printPage.pdf({ path: resolve(output, `print-${dark ? 'dark' : 'light'}.pdf`), format: 'A4', printBackground: true, preferCSSPageSize: true })
    await printPage.close()
  }
  // File switches/unmount must abort preparation and remove the frame.
  const abortResult = await page.evaluate(async () => {
    const controller = new AbortController()
    const count = window.dialogCount
    const promise = printReaderDocument(document.querySelector('.mr-doc'), { title: 'Cancel' }, controller.signal)
    controller.abort()
    try { await promise } catch (error) { if (error.name !== 'AbortError') throw error }
    return { frames: document.querySelectorAll('.mr-print-frame').length, dialogs: window.dialogCount - count }
  })
  assert.deepEqual(abortResult, { frames: 0, dialogs: 0 })
  // A missing stylesheet must fail visibly rather than print broken math.
  await page.route('**/md-reader/assets/katex/katex.min.css', (route) => route.fulfill({ status: 404, body: '' }))
  const failed = await page.evaluate(async () => {
    const count = window.dialogCount
    let error = ''
    try { await printReaderDocument(document.querySelector('.mr-doc'), { title: 'Fail' }, new AbortController().signal) }
    catch (err) { error = err.message }
    return { error, frames: document.querySelectorAll('.mr-print-frame').length, dialogs: window.dialogCount - count }
  })
  assert.match(failed.error, /stylesheet unavailable/)
  assert.equal(failed.frames, 0)
  assert.equal(failed.dialogs, 0)
  await page.unroute('**/md-reader/assets/katex/katex.min.css')
  // Headless Chromium starts native printing but has no dialog to close. Verify
  // the sandbox allows beforeprint, then abort the job instead of waiting for UI.
  const native = await page.evaluate(async () => {
    window.printObserver.disconnect()
    const controller = new AbortController()
    let started = false
    const observer = new MutationObserver(() => {
      const frame = document.querySelector('.mr-print-frame')
      if (!frame) return
      observer.disconnect()
      frame.contentWindow.addEventListener('beforeprint', () => {
        started = true
        setTimeout(() => controller.abort(), 20)
      }, { once: true })
    })
    observer.observe(document.body, { childList: true })
    const deadline = setTimeout(() => controller.abort(), 5000)
    try {
      await printReaderDocument(document.querySelector('.mr-doc'), { title: 'Native print' }, controller.signal)
    } catch (error) {
      if (error.name !== 'AbortError') throw error
    } finally {
      clearTimeout(deadline)
      observer.disconnect()
    }
    return { started, frames: document.querySelectorAll('.mr-print-frame').length }
  })
  assert.deepEqual(native, { started: true, frames: 0 })
  console.log(`PASS: print snapshots, pagination layout, light/dark diagrams, cleanup, cancellation, missing CSS, native print start. PDFs: ${output}`)
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
