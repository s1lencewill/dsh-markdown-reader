/**
 * Engine tests for @s1lencewill/dsh-markdown-reader (browser half, pure parts).
 * Run with: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const engine = require('../lib/client.cjs')

const {
  escapeHtml,
  protectMath,
  parseBlocks,
  renderInline,
  renderDocument,
  safeUrl,
  slugify,
  plainTextOf,
  resolveAssetUrl,
  resolveRelativeLink,
  isMarkdownPath,
  isDelimiterRow,
  splitCells,
  listMarkerAt,
  indentWidth,
  rawUrl,
  basename,
  fileMetaChanged,
  estimateReadingMinutes,
} = engine

const OPTS = { root: '/work', mdPath: 'docs/a.md' }

test('file metadata comparison detects mtime or size changes', () => {
  const current = { mtime: 10, size: 20 }
  assert.equal(fileMetaChanged(current, { mtime: 10, size: 20 }), false)
  assert.equal(fileMetaChanged(current, { mtime: 11, size: 20 }), true)
  assert.equal(fileMetaChanged(current, { mtime: 10, size: 21 }), true)
  assert.equal(fileMetaChanged(null, current), false)
})

test('reading-time estimate supports Chinese and Latin prose', () => {
  assert.equal(estimateReadingMinutes(''), 0)
  assert.equal(estimateReadingMinutes('短文'), 1)
  assert.equal(estimateReadingMinutes('word '.repeat(221)), 2)
  assert.equal(estimateReadingMinutes('```js\n' + 'word '.repeat(300) + '\n```'), 0)
})

test('escapeHtml escapes the five specials', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

// ---------------------------------------------------------------------------
// protectMath
// ---------------------------------------------------------------------------

test('protectMath: inline $...$ becomes a placeholder', () => {
  const prot = protectMath('price is $x+1$ today')
  assert.match(prot.text, /<span class="mr-ph-I0"><\/span>/)
  assert.equal(prot.inlines[0], 'x+1')
  assert.equal(prot.blocks.length, 0)
})

test('protectMath: $1$ (currency-like) is left alone', () => {
  const prot = protectMath('costs $5 and $x$')
  assert.equal(prot.inlines.length, 1)
  assert.equal(prot.inlines[0], 'x')
  assert.ok(prot.text.includes('$5'))

  const currency = protectMath('It costs $5 and $10.')
  assert.equal(currency.inlines.length, 0)
  assert.equal(currency.text, 'It costs $5 and $10.')
})

test('protectMath: spaced dollars stay literal ($ x $)', () => {
  const prot = protectMath('value $ x + 1 $ end')
  assert.equal(prot.inlines.length, 0)
  assert.equal(prot.text, 'value $ x + 1 $ end')
})

test('protectMath: tight scientific math renders (GitHub-style)', () => {
  const tight = protectMath('亚硝酸根（NO$_2^-$）与 O$_3$ 反应')
  assert.equal(tight.inlines.length, 2)
  assert.equal(tight.inlines[0], '_2^-')
  assert.equal(tight.inlines[1], '_3')

  const exp = protectMath('M$^{-1}$ s$^{-1}$')
  assert.equal(exp.inlines.length, 2)
  assert.equal(exp.inlines[0], '^{-1}')

  const num = protectMath('速率高达$3.7 \\times 10^5$ M')
  assert.equal(num.inlines.length, 1)
  assert.equal(num.inlines[0], '3.7 \\times 10^5')
})

test('protectMath: currency stays literal in every form', () => {
  const spaced = protectMath('It costs $5 and $10.')
  assert.equal(spaced.inlines.length, 0)
  assert.equal(spaced.text, 'It costs $5 and $10.')

  const wordy = protectMath('total USD$5 and $10 now')
  assert.equal(wordy.inlines.length, 0)

  const suffix = protectMath('pay 100$ now')
  assert.equal(suffix.inlines.length, 0)

  const digitClose = protectMath('value $x$2 remains text')
  assert.equal(digitClose.inlines.length, 0)
})

test('protectMath: display $$ single-line and multi-line', () => {
  const single = protectMath('$$E=mc^2$$')
  assert.equal(single.blocks[0], 'E=mc^2')
  assert.match(single.text, /<span class="mr-ph-B0"><\/span>/)

  const multi = protectMath('before\n$$\nE=mc^2\ntext\n$$\nafter')
  assert.equal(multi.blocks[0], 'E=mc^2\ntext')
  assert.match(multi.text, /<span class="mr-ph-B0"><\/span>/)
})

test('protectMath: \\( inline and \\[ display (single and multi line)', () => {
  const inline = protectMath('\\(a^2\\)')
  assert.equal(inline.inlines[0], 'a^2')

  const display = protectMath('\\[x=y\\]')
  assert.equal(display.blocks[0], 'x=y')

  const multi = protectMath('before\n\\[\n\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1\n\\]\nafter')
  assert.equal(multi.blocks[0], '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1')
  assert.match(multi.text, /<span class="mr-ph-B0"><\/span>/)
  assert.ok(multi.text.includes('after'))
})

test('protectMath: escaped dollar stays literal', () => {
  const prot = protectMath('cost \\$5 dollars')
  assert.ok(prot.text.includes('\\$5'))
  assert.equal(prot.inlines.length, 0)
})

test('protectMath: code fences and spans are never touched', () => {
  const fence = protectMath('```\n$x$ and $$y$$\n```')
  assert.equal(fence.inlines.length, 0)
  assert.equal(fence.blocks.length, 0)
  assert.ok(fence.text.includes('$x$ and $$y$$'))

  const span = protectMath('run `$x$` now')
  assert.equal(span.inlines.length, 0)
  assert.ok(span.text.includes('`$x$`'))
})

// ---------------------------------------------------------------------------
// parseBlocks
// ---------------------------------------------------------------------------

test('parseBlocks: ATX headings, hr, paragraph', () => {
  const tokens = parseBlocks('# Hello\n\n---\n\nworld'.split('\n'))
  assert.deepEqual(tokens.map((t) => t.t), ['heading', 'hr', 'para'])
  assert.equal(tokens[0].level, 1)
  assert.equal(tokens[0].text, 'Hello')
  assert.equal(tokens[2].text, 'world')
})

test('parseBlocks: setext headings beat hr', () => {
  const h1 = parseBlocks('Title\n====='.split('\n'))
  assert.equal(h1[0].t, 'heading')
  assert.equal(h1[0].level, 1)

  const h2 = parseBlocks('Title\n---'.split('\n'))
  assert.equal(h2[0].t, 'heading')
  assert.equal(h2[0].level, 2)

  const hr = parseBlocks('---'.split('\n'))
  assert.equal(hr[0].t, 'hr')
})

test('parseBlocks: fenced code with language', () => {
  const tokens = parseBlocks('```js\nconst x = 1\n```'.split('\n'))
  assert.equal(tokens[0].t, 'code')
  assert.equal(tokens[0].lang, 'js')
  assert.equal(tokens[0].text, 'const x = 1')
})

test('parseBlocks: blockquote collects and recurses', () => {
  const tokens = parseBlocks('> a\n> b'.split('\n'))
  assert.equal(tokens[0].t, 'blockquote')
  assert.equal(tokens[0].children.length, 1)
  assert.equal(tokens[0].children[0].t, 'para')
  assert.equal(tokens[0].children[0].text, 'a\nb')
})

test('parseBlocks: unordered, ordered, nested and task lists', () => {
  const ul = parseBlocks('- a\n- b'.split('\n'))
  assert.equal(ul[0].t, 'list')
  assert.equal(ul[0].ordered, false)
  assert.equal(ul[0].items.length, 2)

  const nested = parseBlocks('- a\n  - b\n- c'.split('\n'))
  const item0 = nested[0].items[0]
  assert.equal(item0.tokens.length, 2)
  assert.equal(item0.tokens[1].t, 'list')

  const tasks = parseBlocks('- [x] done\n- [ ] todo'.split('\n'))
  assert.equal(tasks[0].items[0].task, true)
  assert.equal(tasks[0].items[1].task, false)
})

test('parseBlocks: GFM table with alignment', () => {
  const tokens = parseBlocks('| a | b |\n| --- | :---: |\n| 1 | 2 |'.split('\n'))
  assert.equal(tokens[0].t, 'table')
  assert.deepEqual(tokens[0].header, ['a', 'b'])
  assert.deepEqual(tokens[0].align, [null, 'c'])
  assert.deepEqual(tokens[0].rows, [['1', '2']])
})

test('parseBlocks: indented code after a blank line', () => {
  const tokens = parseBlocks('para\n\n    code line'.split('\n'))
  assert.equal(tokens[0].t, 'para')
  assert.equal(tokens[1].t, 'code')
  assert.equal(tokens[1].text, 'code line')
})

test('listMarkerAt + indentWidth', () => {
  assert.equal(indentWidth('  x'), 2)
  assert.equal(indentWidth('\tx'), 4)
  const m = listMarkerAt('  - item', 2)
  assert.equal(m.marker, '-')
  assert.equal(m.content, 'item')
  // '- ' + content IS a valid item; a missing space is not.
  const spaced = listMarkerAt('- no space', 0)
  assert.equal(spaced.content, 'no space')
  assert.equal(listMarkerAt('-nospace', 0), null)
  assert.equal(listMarkerAt('x - y', 0), null)
})

// ---------------------------------------------------------------------------
// renderInline
// ---------------------------------------------------------------------------

test('renderInline: bold/italic nesting through the delimiter stack', () => {
  assert.equal(renderInline('**bold**'), '<strong>bold</strong>')
  assert.equal(renderInline('**bold *em* tail**'), '<strong>bold <em>em</em> tail</strong>')
  assert.equal(renderInline('*a **b** c*'), '<em>a <strong>b</strong> c</em>')
  assert.equal(renderInline('_em_'), '<em>em</em>')
  assert.equal(renderInline('a_b_c'), 'a_b_c') // intraword underscore stays
  assert.equal(renderInline('__bold__'), '<strong>bold</strong>')
})

test('renderInline: links with title and safety', () => {
  assert.equal(
    renderInline('[x](https://a.b "T")'),
    '<a href="https://a.b" title="T" target="_blank" rel="noopener noreferrer">x</a>',
  )
  assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
  assert.equal(renderInline('[rel](./other.md)'), '<a href="./other.md">rel</a>')
})

test('renderInline: images resolve against the doc path', () => {
  const rel = renderInline('![alt](./img.png)', OPTS)
  assert.equal(rel, '<img src="/md-reader/raw?root=%2Fwork&amp;path=docs%2Fimg.png" alt="alt" loading="lazy" />')

  const abs = renderInline('![alt](https://x.y/i.png)', OPTS)
  assert.equal(abs, '<img src="https://x.y/i.png" alt="alt" loading="lazy" />')

  const escaped = renderInline('![alt](../../secret.png)', OPTS)
  assert.equal(escaped, 'alt')
})

test('renderInline: code spans, strikethrough, escapes, autolinks, hard breaks', () => {
  assert.equal(renderInline('`a < b`'), '<code>a &lt; b</code>')
  assert.equal(renderInline('~~gone~~'), '<del>gone</del>')
  assert.equal(renderInline('\\*not em\\*'), '*not em*')
  assert.equal(
    renderInline('<https://x.y>'),
    '<a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a>',
  )
  const br = renderInline('a  \nb')
  assert.equal(br, 'a<br />\nb')
})

test('renderInline: unsafe schemes degrade to text', () => {
  assert.equal(renderInline('![a](data:text/html,x)'), 'a')
})

// ---------------------------------------------------------------------------
// renderDocument pipeline
// ---------------------------------------------------------------------------

test('renderDocument: headings get slug ids and a TOC', () => {
  const out = renderDocument('# Hello World\n\nText\n\n## 你好 世界\n\nMore', OPTS)
  assert.match(out.html, /<h1 id="hello-world">Hello World<\/h1>/)
  assert.match(out.html, /<h2 id="你好-世界">你好 世界<\/h2>/)
  assert.deepEqual(out.toc, [
    { level: 1, id: 'hello-world', label: 'Hello World' },
    { level: 2, id: '你好-世界', label: '你好 世界' },
  ])
})

test('renderDocument: duplicate slugs get -1 suffixes', () => {
  const out = renderDocument('# Same\n# Same', OPTS)
  assert.deepEqual(out.toc.map((e) => e.id), ['same', 'same-1'])
})

test('renderDocument: math restored (pending code without KaTeX in Node)', () => {
  const out = renderDocument('price $x+1$ ok\n\n$$\nE=mc^2\n$$', OPTS)
  assert.match(out.html, /<code class="mr-math-pending">x\+1<\/code>/)
  assert.match(out.html, /<span class="mr-math-display"><code class="mr-math-pending">E=mc\^2<\/code><\/span>/)
  assert.doesNotMatch(out.html, /<p><span class="mr-math-display">/)
})

test('renderDocument: math in headings is excluded from the TOC label', () => {
  const out = renderDocument('# Value $x$ here', OPTS)
  assert.deepEqual(out.toc, [{ level: 1, id: 'value-here', label: 'Value here' }])
})

test('renderDocument: mermaid fences carry the marker class', () => {
  const out = renderDocument('```mermaid\ngraph TD\nA-->B\n```', OPTS)
  assert.match(out.html, /<pre class="mr-mermaid"><code class="language-mermaid">graph TD\nA--&gt;B<\/code><\/pre>/)
})

test('renderDocument: task lists and tables render', () => {
  const tasks = renderDocument('- [x] done', OPTS)
  assert.match(tasks.html, /<li class="mr-task"><div class="mr-task-row"><input type="checkbox" disabled checked \/><span class="mr-task-body"><p>done<\/p><\/span><\/div><\/li>/)
  const table = renderDocument('| a |\n| --- |\n| 1 |', OPTS)
  assert.match(table.html, /<table><thead><tr><th>a<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><\/tr><\/tbody><\/table>/)
})

// ---------------------------------------------------------------------------
// sanitizer (Node has no DOMParser: passthrough only; browser behavior is
// exercised manually in the GUI)
// ---------------------------------------------------------------------------

test('sanitizeHtml passes through when DOMParser is unavailable', () => {
  const html = '<p onclick="x">text</p>'
  assert.equal(engine.sanitizeHtml(html), html)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('safeUrl allowlist', () => {
  assert.equal(safeUrl('https://a.b'), 'https://a.b')
  assert.equal(safeUrl('http://a.b'), 'http://a.b')
  assert.equal(safeUrl('mailto:x@y.z'), 'mailto:x@y.z')
  assert.equal(safeUrl('#frag'), '#frag')
  assert.equal(safeUrl('./rel.png'), './rel.png')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('data:text/html,x'), null)
  assert.equal(safeUrl(''), null)
})

test('slugify and plainTextOf', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('  a -- b  '), 'a-b')
  assert.equal(slugify('!!!'), 'section')
  assert.equal(plainTextOf('**bold** and [link](https://x) and `code`'), 'bold and link and code')
  assert.equal(plainTextOf('![alt](img.png)'), 'alt')
})

test('slugify output always passes the sanitizer id allowlist (browser regression)', () => {
  const { ID_RE, slugify: slug } = engine
  const samples = ['你好 世界', '亚硝酸（HONO）及其共轭碱', 'E = mc^2', 'Hello, World!', '100% 正确', '§part·two', '!!!', 'a  b  a', 'x_x :y: -z-']
  for (const sample of samples) {
    const id = slug(sample)
    assert.ok(ID_RE.test(id), `slug for ${JSON.stringify(sample)} = ${JSON.stringify(id)} must satisfy ID_RE`)
  }
  assert.equal(slug('你好 世界'), '你好-世界')
})

test('resolveAssetUrl: absolute / relative / root-relative / escape / suffix', () => {
  assert.deepEqual(resolveAssetUrl('docs/a.md', 'https://x/y.png'), { kind: 'absolute', url: 'https://x/y.png' })
  assert.deepEqual(resolveAssetUrl('docs/a.md', './y.png'), { kind: 'relative', path: 'docs/y.png', suffix: '' })
  assert.deepEqual(resolveAssetUrl('docs/a.md', '/top.png'), { kind: 'relative', path: 'top.png', suffix: '' })
  assert.deepEqual(resolveAssetUrl('docs/a.md', '../y.png?v=2'), { kind: 'relative', path: 'y.png', suffix: '?v=2' })
  assert.deepEqual(resolveAssetUrl('docs/a.md', '../../y.png'), { kind: 'escape' })
})

test('resolveRelativeLink: in-document navigation resolution', () => {
  assert.deepEqual(resolveRelativeLink('docs/a.md', '../other.md#sec'), { path: 'other.md', fragment: 'sec' })
  assert.deepEqual(resolveRelativeLink('docs/a.md', 'b.md'), { path: 'docs/b.md', fragment: null })
  assert.deepEqual(resolveRelativeLink('docs/a.md', 'my%20file.md?v=2#part%201'), { path: 'docs/my file.md', fragment: 'part 1' })
  assert.deepEqual(resolveRelativeLink('docs/a.md', '..\\other.md'), { path: 'other.md', fragment: null })
  assert.deepEqual(resolveRelativeLink('docs/a.md', '#anchor'), { path: null, fragment: 'anchor' })
  assert.equal(resolveRelativeLink('docs/a.md', '../../../x.md'), null)
})

test('path helpers', () => {
  assert.equal(isMarkdownPath('docs/x.md'), true)
  assert.equal(isMarkdownPath('x.MD'), true)
  assert.equal(isMarkdownPath('x.markdown'), true)
  assert.equal(isMarkdownPath('x.mdx'), true)
  assert.equal(isMarkdownPath('x.txt'), false)
  assert.equal(isMarkdownPath('docs/x.md#a?b=1'), true)
  assert.equal(basename('docs/a.md'), 'a.md')
  assert.equal(basename('a.md'), 'a.md')
  assert.equal(rawUrl('/w dir', 'a b.png', '?v=1'), '/md-reader/raw?root=%2Fw%20dir&path=a%20b.png&v=1')
  assert.equal(rawUrl('/w', 'a.png', '?v=1#preview'), '/md-reader/raw?root=%2Fw&path=a.png&v=1#preview')
})

test('table cell helpers', () => {
  assert.deepEqual(splitCells('| a | b |'), ['a', 'b'])
  assert.deepEqual(splitCells('a | b'), ['a', 'b'])
  assert.deepEqual(splitCells('a \\| b | c'), ['a | b', 'c'])
  assert.equal(isDelimiterRow('| --- | :--: |'), true)
  assert.equal(isDelimiterRow('| a | b |'), false)
  assert.equal(isDelimiterRow('no pipes'), false)
})

// ---------------------------------------------------------------------------
// themes
// ---------------------------------------------------------------------------

test('themes: registry, cycling, and emitted CSS', () => {
  const { READER_THEMES, buildThemeCss, cycleTheme } = engine
  const ids = Object.keys(READER_THEMES)
  assert.equal(ids.length, 4)
  assert.deepEqual(ids, ['warm', 'cool', 'eye', 'plain'])

  for (const id of ids) {
    const css = buildThemeCss(id)
    assert.ok(css.startsWith('#mr-root { '), `${id} css starts with the var block`)
    assert.ok(css.includes('body[data-ds-dark-theme] #mr-root { '), `${id} css has the dark block`)
    for (const key of ['--mr-bg', '--mr-text', '--mr-border', '--mr-accent', '--mr-paper', '--mr-paper-grain']) {
      assert.ok(css.includes(key), `${id} css defines ${key}`)
    }
  }
  // Warm paper carries the grain; the clean themes do not.
  assert.ok(buildThemeCss('warm').includes('feTurbulence'))
  assert.ok(!buildThemeCss('cool').includes('feTurbulence'))
  assert.ok(!buildThemeCss('plain').includes('feTurbulence'))
  assert.ok(buildThemeCss('warm').includes('data:image/svg+xml'))

  // Cycling wraps around.
  assert.equal(cycleTheme('warm'), 'cool')
  assert.equal(cycleTheme('cool'), 'eye')
  assert.equal(cycleTheme('eye'), 'plain')
  assert.equal(cycleTheme('plain'), 'warm')
  assert.equal(cycleTheme('unknown'), 'warm')
  assert.deepEqual(READER_THEMES.warm.label, '暖纸')
  assert.deepEqual(READER_THEMES.cool.label, '清冷')
  assert.deepEqual(READER_THEMES.eye.label, '护眼')
  assert.deepEqual(READER_THEMES.plain.label, '素白')
})

// ---------------------------------------------------------------------------
// round-trips
// ---------------------------------------------------------------------------

test('renderDocument: a realistic README round-trip', () => {
  const source = [
    '# My Docs',
    '',
    'A **bold** intro with $\\pi$ math and `code`.',
    '',
    '## Features',
    '',
    '- [x] done',
    '- [ ] pending',
    '  - nested',
    '',
    '| Col A | Col B |',
    '| :---- | ----: |',
    '| 1     | 2     |',
    '',
    '> quote line',
    '',
    '```js',
    'const x = 1 // $not-math$',
    '```',
    '',
    'See [other](./other.md#part).',
  ].join('\n')
  const out = renderDocument(source, OPTS)
  assert.match(out.html, /<h1 id="my-docs">My Docs<\/h1>/)
  assert.match(out.html, /<strong>bold<\/strong>/)
  assert.match(out.html, /<code class="mr-math-pending">\\pi<\/code>/)
  assert.match(out.html, /<code>code<\/code>/)
  assert.match(out.html, /<li class="mr-task">/)
  assert.match(out.html, /<table>/)
  assert.match(out.html, /<blockquote><p>quote line<\/p><\/blockquote>/)
  assert.match(out.html, /\$not-math\$/)
  assert.match(out.html, /<a href="\.\/other\.md#part">other<\/a>/)
  assert.deepEqual(out.toc.map((e) => e.label), ['My Docs', 'Features'])
})
