/**
 * End-to-end math verification against REAL KaTeX (vendored UMD).
 * Run: node test/katex-e2e.mjs
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

// Real KaTeX from the plugin's vendored assets (UMD → globalThis.katex).
const katexSrc = fs.readFileSync(`${root}/vendor/katex/katex.min.js`, 'utf8')
new Function(katexSrc)()
if (typeof globalThis.katex !== 'object') {
  console.error('FAIL: katex did not load')
  process.exit(1)
}

const engine = require('../lib/client.cjs')

const doc = [
  '# 公式测试',
  '',
  '行内: E = $E=mc^2$ 著名。',
  '',
  '括号行内: 勾股 \\(a^2+b^2=c^2\\)。',
  '',
  '宽松空格: $ x+1 $ 值。',
  '',
  '单行块: $$\\int_0^\\infty e^{-x^2}dx$$',
  '',
  '多行块:',
  '$$',
  '\\sum_{k=1}^n k = \\frac{n(n+1)}{2}',
  '$$',
  '',
  '方括号单行: \\[\\frac{a}{b}\\]',
  '',
  '方括号多行:',
  '\\[',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  '\\]',
  '',
  '紧贴科学公式: 亚硝酸根（NO$_2^-$）与 O$_3$ 反应，HNO$_3$ 与 NO$_3^-$ 的分配，',
  '速率常数高达 $3.7 \\times 10^5$ M$^{-1}$ s$^{-1}$。',
  '',
  '价格不动: It costs $5 and $10.',
  '',
  '代码不动: `$x$` 和',
  '',
  '```',
  '$not math$',
  '```',
].join('\n')

const out = engine.renderDocument(doc, { root: '/w', mdPath: 'math.md' })
const katexCount = (out.html.match(/class="katex/g) ?? []).length
const displayCount = (out.html.match(/katex-display/g) ?? []).length
const pendingCount = (out.html.match(/mr-math-pending/g) ?? []).length

console.log(`katex spans: ${katexCount} | display blocks: ${displayCount} | pending: ${pendingCount}`)
console.log(`currency intact: ${out.html.includes('$5 and $10')}`)
console.log(`code intact: ${out.html.includes('$not math$')} | codespan intact: ${out.html.includes('$x$')}`)

const fail = pendingCount > 0 || katexCount < 6 || displayCount < 4
  || !out.html.includes('$5 and $10') || !out.html.includes('$not math$')
console.log(fail ? 'FAIL' : 'ALL FORMULA CHECKS PASS')
process.exit(fail ? 1 : 0)
