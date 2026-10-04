// Optional Chromium layout regression: NODE_PATH must resolve Playwright.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 Chrome/140 Electron/38' })
  await page.setContent('<div id="native" style="position:fixed;top:0;right:0;width:200px;height:36px;z-index:2147483000;background:white">Native window controls</div><div id="mr-mount"><div id="mr-root"><div class="mr-overlay"><div class="mr-header"><span class="mr-title">Very long document title 很长的文档名称.md</span><input class="mr-path" value="docs/example.md"><span class="mr-doc-meta">20 分钟 · 更新于 10/04 19:20:24</span><button class="mr-btn">打印 / PDF</button><label class="mr-auto-reload"><input type="checkbox">自动重载</label><button class="mr-icon-btn">↻</button><button class="mr-icon-btn">▣</button><button class="mr-icon-btn">☰</button><button class="mr-icon-btn">−</button><button class="mr-icon-btn">+</button><button class="mr-icon-btn">◉</button><button class="mr-icon-btn">×</button></div><div class="mr-body">Document</div></div></div></div>')
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/client.cjs', import.meta.url)) })
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = READER_CSS
    document.head.append(style)
    window.disposeInset = installReaderTitlebarInset(document.getElementById('mr-mount'))
    window.clicks = 0
    document.querySelectorAll('.mr-header button').forEach(button => button.addEventListener('click', () => window.clicks++))
  })
  for (const width of [1920, 1280, 640]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForFunction(() => document.querySelector('.mr-overlay').getBoundingClientRect().top === 36)
    const buttons = page.locator('.mr-header button')
    for (let i = 0; i < await buttons.count(); i++) {
      const box = await buttons.nth(i).boundingBox()
      assert(box.y >= 36 && box.x >= 0 && box.x + box.width <= width, `Toolbar control outside safe viewport at ${width}px`)
      await buttons.nth(i).click({ timeout: 2000 })
    }
  }
  assert.equal(await page.evaluate(() => window.clicks), 24)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 Chrome/140', configurable: true })
    window.dispatchEvent(new Event('resize'))
  })
  assert.equal(await page.locator('.mr-overlay').evaluate(el => el.getBoundingClientRect().top), 0)
  await page.evaluate(() => window.disposeInset())
  console.log('PASS: desktop toolbar clickability at 1920/1280/640px; ordinary browser has no titlebar gap.')
} finally {
  await browser.close()
}
