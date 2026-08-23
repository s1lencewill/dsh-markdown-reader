import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../lib/index.js'

function makeResponse() {
  let resolve
  const done = new Promise((r) => { resolve = r })
  const chunks = []
  const response = {
    status: 0,
    headers: {},
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) })
    },
  }
  return { response, done }
}

async function request(route, { method, url, headers = {}, body = '' }) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  const { response, done } = makeResponse()
  await route.handler(req, response)
  return done
}

test('host routes enforce workspace boundaries and safe asset responses', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-md-reader-'))
  const workspace = join(parent, 'workspace')
  const outside = join(parent, 'outside.md')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'docs', 'readme.md'), '# Hello\n')
  await writeFile(join(workspace, 'docs', 'note.txt'), 'not markdown')
  await writeFile(join(workspace, 'docs', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await writeFile(outside, '# Outside\n')
  t.after(() => rm(parent, { recursive: true, force: true }))

  const routes = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    workspaceRegistry: { list: () => [{ path: workspace }] },
    systemPrompt: { section: () => () => {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  }
  apply(ctx)
  t.after(() => { for (const dispose of effects) dispose() })

  assert.deepEqual(routes.map((route) => route.path), ['/md-reader', '/aionui-panel/katex', '/aionui-panel/hljs'])
  const mdRoute = routes[0]

  await t.test('reads markdown inside the registered workspace', async () => {
    const res = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/read',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: 'docs/readme.md' }),
    })
    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body.toString('utf8'))
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.content, '# Hello\n')
    assert.equal(envelope.value.truncated, false)
  })

  await t.test('checks markdown metadata without returning content', async () => {
    const res = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/stat',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: 'docs/readme.md' }),
    })
    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body.toString('utf8'))
    assert.equal(envelope.ok, true)
    assert.equal(typeof envelope.value.mtime, 'number')
    assert.equal(envelope.value.size, Buffer.byteLength('# Hello\n'))
    assert.equal('content' in envelope.value, false)

    const escaped = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/stat',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: '../outside.md' }),
    })
    assert.equal(escaped.status, 403)
  })

  await t.test('rejects path traversal and non-markdown reads', async () => {
    const escaped = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/read',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: '../outside.md' }),
    })
    assert.equal(escaped.status, 403)
    assert.equal(JSON.parse(escaped.body).error.code, 'path-outside-root')

    const text = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/read',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: 'docs/note.txt' }),
    })
    assert.equal(text.status, 415)
    assert.equal(JSON.parse(text.body).error.code, 'unsupported-type')
  })

  await t.test('requires JSON for the POST route', async () => {
    const res = await request(mdRoute, {
      method: 'POST',
      url: '/md-reader/read',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(res.status, 415)
  })

  await t.test('sandboxes SVG and marks raw responses nosniff', async () => {
    const url = `/md-reader/raw?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent('docs/image.svg')}`
    const res = await request(mdRoute, { method: 'GET', url })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/svg+xml')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.match(res.headers['content-security-policy'], /sandbox/)
  })

  await t.test('answers asset HEAD without a response body', async () => {
    const res = await request(mdRoute, { method: 'HEAD', url: '/md-reader/assets/mermaid/README.txt' })
    assert.equal(res.status, 200)
    assert.equal(res.body.length, 0)
    assert.ok(Number(res.headers['content-length']) > 0)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })
})
