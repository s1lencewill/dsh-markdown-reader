/**
 * @linxin666/dsh-markdown-reader — host half: the workspace-gated read-only
 * routes (/md-reader/read, /md-reader/raw) plus the vendored-asset route
 * (/md-reader/assets/*, KaTeX + optional Mermaid drop-in) on the shared
 * webserver, and an agent announcement through the system-prompt section
 * mechanism. The browser half (exports "./client") is served by
 * client-modules from the same package's dsh.client declaration.
 *
 * Security model (mirrors dsh-aionui-panel's workspace gate): every fs route
 * canonicalizes the requested project root with realpath and requires it to
 * be a registered workspace (or a directory inside one); the resolved file
 * is realpathed again and prefix-checked, so `..` and symlink escapes are
 * rejected. The reader is strictly read-only: there is no write route.
 *
 * Zero build, zero runtime dependencies: pure Node ESM.
 * @module @linxin666/dsh-markdown-reader
 */

import { open, realpath, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Required services: the route registry, the workspace registry, and the prompt band. */
export const inject = ['webServer', 'workspaceRegistry', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 220

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const MARKDOWN_READER_GUIDANCE = '本机已安装 dsh-markdown-reader 插件（DSH Web GUI 的全屏 Markdown 阅读器）：工作区内的 .md/.markdown/.mdx 文件可在全屏阅读浮层中打开，支持 GFM 语法（表格/任务列表/删除线等）、大纲目录与滚动定位、KaTeX 数学公式、Mermaid 图表（离线降级展示）、相对路径图片与文档内 .md 跳转。入口：右下角悬浮按钮（打开最近文件/路径输入）、Ctrl+Shift+M 快捷键、右侧预览面板工具栏的「阅读模式」按钮。用户提到「阅读器 / 阅读模式 / markdown 阅读 / 阅读 xx.md」时即指本插件。数据经宿主端 /md-reader/* 路由读取，仅限已注册工作区，只读。'

// ---------------------------------------------------------------------------
// Error envelope (PanelError-shaped so clients can share the same decoding).
// ---------------------------------------------------------------------------

/** One structured error. */
const FAIL = (code, message) => ({ ok: false, error: { code, message } })

/** Write one JSON envelope response. */
function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Read a JSON request body into an unknown value; null when unparseable. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk
    chunks.push(buffer)
    total += buffer.length
    if (total > 1 << 20) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Extract the required string field from a JSON object payload. */
function strField(payload, key) {
  if (typeof payload !== 'object' || payload === null) return null
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// ---------------------------------------------------------------------------
// Workspace gate (same canonicalization contract as dsh-aionui-panel).
// ---------------------------------------------------------------------------

/** Normalize a path for prefix comparison (separators + trailing slash; case on win32). */
function normalizeForPrefix(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` lives inside (or equals) `root`. */
function isPathInside(root, child) {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Gate one project root: canonicalize and require workspace membership.
 * @param ctx - context carrying the workspace registry.
 * @returns a gate function: {ok:true, canonical} or {ok:false, error}.
 */
function createWorkspaceGate(ctx) {
  return async (root) => {
    if (typeof root !== 'string' || root === '') {
      return { ok: false, error: { code: 'workspace-unknown', message: 'empty project root' } }
    }
    let canonical
    try {
      canonical = await realpath(root)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    const workspaces = ctx.workspaceRegistry.list()
    for (const workspace of workspaces) {
      if (isPathInside(workspace.path, canonical)) return { ok: true, canonical }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not inside a registered workspace' } }
  }
}

// ---------------------------------------------------------------------------
// Limits and mime maps.
// ---------------------------------------------------------------------------

/** Cap for /md-reader/read (larger files are truncated with a flag). */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** Hard cap for /md-reader/raw (images and other embedded assets). */
const MAX_RAW_BYTES = 100 * 1024 * 1024

/** Markdown extensions the reader accepts. */
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mdx'])

/** Mime map for raw file serving (images and other embeddable assets). */
const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** Mime map for vendored assets. */
const ASSET_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

/** The vendored asset directory (package root/vendor). */
const ASSET_DIR = fileURLToPath(new URL('../vendor/', import.meta.url))

// ---------------------------------------------------------------------------
// Route handlers.
// ---------------------------------------------------------------------------

/**
 * Resolve a client-supplied relative path against a gated canonical root and
 * verify containment on the REAL path (defeats `..` and symlink escapes).
 * @returns {ok:true, abs, real} or {ok:false, error, status}.
 */
async function resolveInside(gate, root, relPath) {
  const gated = await gate(root)
  if (!gated.ok) return { ok: false, error: gated.error, status: 400 }
  const joined = join(gated.canonical, relPath)
  if (!isPathInside(gated.canonical, joined)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path escapes the project root' }, status: 403 }
  }
  let real
  try {
    real = await realpath(joined)
  } catch {
    return { ok: false, error: { code: 'not-found', message: 'file does not exist' }, status: 404 }
  }
  if (!isPathInside(gated.canonical, real)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path resolves outside the project root' }, status: 403 }
  }
  return { ok: true, real }
}

/**
 * GET /md-reader/raw: stream one workspace file (markdown image srcs).
 * The bytes go out with the derived mime so an <img> can load them.
 */
async function serveRaw(gate, url, res) {
  const root = url.searchParams.get('root')
  const path = url.searchParams.get('path')
  if (root === null || root === '' || path === null || path === '') {
    json(res, FAIL('malformed-request', 'missing root or path'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, path.replaceAll('\\', '/'))
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  if (info.size > MAX_RAW_BYTES) {
    json(res, FAIL('too-large', 'file exceeds the raw serving limit'), 413)
    return
  }
  try {
    const body = await readFile(resolved.real)
    res.writeHead(200, {
      'content-type': RAW_MIME[extname(resolved.real).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * GET/HEAD /md-reader/assets/*: serve one vendored asset (KaTeX JS/CSS/fonts,
 * optional Mermaid drop-in) from the plugin package's vendor/ directory.
 * HEAD answers with the headers only so the client can probe for the optional
 * Mermaid drop-in without printing a 404 (or downloading it twice).
 */
async function serveAsset(url, res, headOnly) {
  await serveVendorAsset(url, res, headOnly, '/md-reader/assets/', '')
}

/**
 * Serve one file from a vendor subdirectory, for an arbitrary URL prefix.
 * Shared by /md-reader/assets/* and the aionui-panel compat routes.
 */
async function serveVendorAsset(url, res, headOnly, prefix, subdir) {
  const rel = url.pathname.slice(prefix.length)
  if (rel === '' || !/^[a-zA-Z0-9@._/+-]+$/.test(rel) || rel.includes('..')) {
    res.writeHead(404)
    res.end()
    return
  }
  const base = join(ASSET_DIR, subdir)
  const resolved = join(base, rel)
  if (!isPathInside(base, resolved)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(resolved)
    const headers = {
      'content-type': ASSET_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    }
    res.writeHead(200, headers)
    res.end(headOnly ? undefined : body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * GET/HEAD /aionui-panel/katex/* and /aionui-panel/hljs/* compat routes.
 * Registered under LONGER prefixes than the aionui-panel bundle's own
 * `/aionui-panel` prefix, so longest-prefix-wins routes these asset requests
 * here. Reason: after an in-place config hot-reload (skin switch) the panel's
 * in-memory host code can end up in a hybrid broken state (405 on its asset
 * subroutes); serving the same vendored assets from here keeps panel math
 * and highlighting alive without touching the panel package.
 */
async function serveCompatAsset(url, res, headOnly) {
  if (url.pathname.startsWith('/aionui-panel/katex/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/katex/', 'katex')
    return
  }
  if (url.pathname.startsWith('/aionui-panel/hljs/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/hljs/', 'hljs')
    return
  }
  res.writeHead(404)
  res.end()
}

/**
 * POST /md-reader/read: read one workspace markdown file (gated, capped).
 * Returns {content, mtime, size, truncated}.
 */
async function handleRead(gate, payload, res) {
  const root = strField(payload, 'root')
  const path = strField(payload, 'path')
  if (root === null || path === null) {
    json(res, FAIL('malformed-request', 'missing root or path'), 400)
    return
  }
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const ext = extname(resolved.real).toLowerCase()
  if (!MD_EXT.has(ext)) {
    json(res, FAIL('unsupported-type', 'not a markdown file'), 415)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  const truncated = info.size > MAX_READ_BYTES
  try {
    // Open + partial read: a 200MB file only costs the capped buffer, not a
    // full readFile into memory.
    const fh = await open(resolved.real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES))
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0)
      json(res, {
        ok: true,
        value: {
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          mtime: info.mtimeMs,
          size: info.size,
          truncated,
        },
      })
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * Register the /md-reader route prefix.
 * @returns the route disposer.
 */
function registerRoutes(ctx, gate) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname.startsWith('/md-reader/assets/')) {
        await serveAsset(url, res, req.method === 'HEAD')
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/raw') {
        await serveRaw(gate, url, res)
        return
      }
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    // Require an explicit JSON content-type: cross-site simple requests (no
    // preflight) cannot set application/json, so this blocks form-based CSRF
    // from driving the read routes.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      json(res, FAIL('malformed-request', 'expected application/json'), 415)
      return
    }
    const payload = await readJsonBody(req)
    if (payload === null) {
      json(res, FAIL('malformed-request', 'malformed request'), 400)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/md-reader/read') {
      await handleRead(gate, payload, res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  // aionui-panel asset compat routes (shadow the panel's broken subroutes
  // via longest-prefix-wins; see serveCompatAsset).
  const compatHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    await serveCompatAsset(url, res, req.method === 'HEAD')
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/md-reader', handler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/katex', handler: compatHandler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/hljs', handler: compatHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Mount the read routes and the agent announcement.
 * @param ctx - context carrying webServer, workspaceRegistry, systemPrompt.
 */
export function apply(ctx) {
  const gate = createWorkspaceGate(ctx)
  ctx.effect(() => registerRoutes(ctx, gate), 'dsh-markdown-reader: /md-reader routes')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:markdown-reader',
    order: SECTION_ORDER,
    text: MARKDOWN_READER_GUIDANCE,
  }), 'dsh-markdown-reader: prompt section')
}
