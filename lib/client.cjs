'use strict'
/* ============================================================================
 * @s1lencewill/dsh-markdown-reader — browser half (single-file bundle)
 *
 * Served verbatim by dsh-client-modules at /plugins/<pkg>/client.js. The
 * loader contract is reproduced exactly: `window.__ModuleLoader__.load({id,
 * factory})` where the factory receives the module-table `require` and its
 * RETURN VALUE becomes the module's exports ({inject, apply}).
 *
 * Zero-build layout: everything lives in this one file. React is required
 * lazily from the shell's module table (react, react-dom/client), so this
 * bundle has no imports and no runtime dependencies of its own.
 *
 * Sections:
 *   1. constants / small helpers
 *   2. math protection (KaTeX placeholders)
 *   3. GFM block parser
 *   4. GFM inline renderer (emphasis via delimiter stack)
 *   5. HTML sanitizer (DOMParser walk, allowlist)
 *   6. path/url resolution helpers
 *   7. KaTeX + Mermaid loaders
 *   8. i18n
 *   9. host API + persistence
 *  10. React reader UI (overlay + outline + picker + floating button)
 *  11. entry wiring (keyboard, panel collaboration, sessions, apply)
 *  12. loader registration + Node test exports
 *
 * Failure policy: every DOM/runtime wiring failure is logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws.
 * ========================================================================== */

// #region ===== 1. constants / small helpers =====

const PKG_ID = '@s1lencewill/dsh-markdown-reader'
const READ_ROUTE = '/md-reader/read'
const STAT_ROUTE = '/md-reader/stat'
const RAW_ROUTE = '/md-reader/raw'
const ASSET_BASE = '/md-reader/assets'
const MD_EXT_RE = /\.(md|markdown|mdown|mdx)$/i
const RECENT_KEY_PREFIX = 'md-reader:recent:'
const UI_KEY_PREFIX = 'md-reader:ui:'
const RECENT_CAP = 8
const FONT_MIN = 12
const FONT_MAX = 24
const FONT_DEFAULT = 16
const CHANGE_POLL_MS = 4000
const LONG_SECTION_CHARS = 900
const LONG_SECTION_NODES = 7

/** Escape HTML special characters. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Count one char-run length at i. */
function runLen(s, i, ch) {
  let j = i
  while (j < s.length && s[j] === ch) j += 1
  return j - i
}

/** Find the next run of `ch` with length >= len, or -1. */
function findRun(s, from, ch, len) {
  let i = from
  while (i < s.length) {
    if (s[i] === ch) {
      const l = runLen(s, i, ch)
      if (l >= len) return i
      i += l
    } else {
      i += 1
    }
  }
  return -1
}

/** Whether a line is blank. */
function isBlank(line) {
  return /^[ \t]*$/.test(line)
}

/** Leading indent width (tabs = 4). */
function indentWidth(line) {
  let w = 0
  for (const ch of line) {
    if (ch === ' ') w += 1
    else if (ch === '\t') w += 4
    else break
  }
  return w
}

/** Whether two host metadata snapshots represent different file contents. */
function fileMetaChanged(current, next) {
  if (current === null || next === null || current === undefined || next === undefined) return false
  return Number(current.mtime) !== Number(next.mtime) || Number(current.size) !== Number(next.size)
}

/** Mixed Chinese/Latin reading-time estimate, rounded up to whole minutes. */
function estimateReadingMinutes(source) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
  if (cjk === 0 && latin === 0) return 0
  return Math.max(1, Math.ceil(cjk / 500 + latin / 220))
}

// #endregion

// #region ===== 2. math protection =====

/**
 * Placeholder tokens are REAL HTML elements (<span class="mr-ph-…">), not
 * control characters: they must survive the DOMParser/innerHTML round-trip of
 * the sanitizer byte-for-byte (HTML preprocessing mangles U+0001 text).
 * The sanitizer whitelists the mr-ph-* class on spans, and restoreMath swaps
 * the tokens for KaTeX HTML after sanitizing.
 */
const BLOCK_PH = (i) => `<span class="mr-ph-B${i}"></span>`
const INLINE_PH = (i) => `<span class="mr-ph-I${i}"></span>`
/** Matches every math placeholder. */
const PH_RE = /<span class="mr-ph-[BI]\d+"><\/span>/g
/** Matches one placeholder with captured kind/index. */
const PH_DETAIL_RE = /<span class="mr-ph-([BI])(\d+)"><\/span>/g

/** Whether index i is at a line start (or the document start). */
function atLineStart(text, i) {
  return i === 0 || text[i - 1] === '\n'
}

/**
 * Replace math ($, $$, \( \), \[ \]) with opaque placeholders so the block and
 * inline passes never see TeX. Code spans and fenced code blocks are copied
 * verbatim (math inside code is code, not math). Escaped dollars (\$) stay
 * literal for the inline pass to decode.
 *
 * @param source - raw markdown source.
 * @returns {{text: string, blocks: string[], inlines: string[]}}
 */
function protectMath(source) {
  const text = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = []
  const inlines = []
  let out = ''
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]

    // Fenced code block: copy verbatim (math is code here).
    if (atLineStart(text, i)) {
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i))
      if (fm !== null) {
        const marker = fm[1]
        const ch = marker[0]
        const len = marker.length
        out += fm[0]
        i += fm[0].length
        while (i < n) {
          const nl = text.indexOf('\n', i)
          const end = nl === -1 ? n : nl
          const line = text.slice(i, end)
          const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}\\s*$`)
          out += line
          i = end
          if (closeRe.test(line)) {
            if (i < n) { out += '\n'; i += 1 }
            break
          }
          if (i < n) { out += '\n'; i += 1 }
        }
        continue
      }
    }

    // Code span: copy verbatim.
    if (c === '`') {
      const len = runLen(text, i, '`')
      const close = findRun(text, i + len, '`', len)
      if (close !== -1) {
        out += text.slice(i, close + len)
        i = close + len
        continue
      }
      out += text.slice(i, i + len)
      i += len
      continue
    }

    // Escaped backslash: copy both chars, never treat what follows as math.
    if (c === '\\' && text[i + 1] === '\\') {
      out += '\\\\'
      i += 2
      continue
    }

    // Display math: $$...$$
    if (c === '$' && text[i + 1] === '$') {
      const rest = text.slice(i + 2)
      const closeIdx = rest.indexOf('$$')
      if (closeIdx !== -1) {
        const span = rest.slice(0, closeIdx)
        if (!span.includes('\n') && span.trim() !== '') {
          blocks.push(span.trim())
          out += BLOCK_PH(blocks.length - 1)
          i += 2 + closeIdx + 2
          continue
        }
      }
      // Multi-line: consume through the line that closes.
      const idx = blocks.length
      blocks.push('')
      out += BLOCK_PH(idx)
      i += 2
      let buf = ''
      while (i < n) {
        const nl = text.indexOf('\n', i)
        const end = nl === -1 ? n : nl
        const line = text.slice(i, end)
        const ci = line.indexOf('$$')
        if (ci !== -1) {
          buf += (buf === '' ? '' : '\n') + line.slice(0, ci)
          blocks[idx] = buf.trim()
          i = end
          if (i < n) i += 1
          break
        }
        buf += (buf === '' ? '' : '\n') + line
        i = end
        if (i < n) i += 1
      }
      continue
    }

    // Display math: \[...\] (single line or multi line).
    if (c === '\\' && text[i + 1] === '[') {
      const lineEnd = text.indexOf('\n', i)
      const sameLine = text.indexOf('\\]', i + 2)
      if (sameLine !== -1 && (lineEnd === -1 || sameLine < lineEnd)) {
        const tex = text.slice(i + 2, sameLine).trim()
        if (tex !== '') {
          blocks.push(tex)
          out += BLOCK_PH(blocks.length - 1)
          i = sameLine + 2
          continue
        }
      }
      // Multi-line: collect through the line that closes (bail to literal
      // when no closer exists anywhere).
      let p = lineEnd === -1 ? n : lineEnd + 1
      let buf = ''
      let found = false
      let closeAt = -1
      while (p < n) {
        const nl = text.indexOf('\n', p)
        const end = nl === -1 ? n : nl
        const line = text.slice(p, end)
        const ci = line.indexOf('\\]')
        if (ci !== -1) {
          buf += (buf === '' ? '' : '\n') + line.slice(0, ci)
          found = true
          closeAt = p + ci
          break
        }
        buf += (buf === '' ? '' : '\n') + line
        p = end === n ? n : end + 1
      }
      if (found && buf.trim() !== '') {
        blocks.push(buf.trim())
        out += BLOCK_PH(blocks.length - 1)
        i = closeAt + 2
        continue
      }
      out += '\\['
      i += 2
      continue
    }

    // Escaped dollar: literal (the inline pass decodes it later).
    if (c === '\\' && text[i + 1] === '$') {
      out += '\\$'
      i += 2
      continue
    }

    // Inline math: $...$ or \(...\) (single line; GitHub-style flanking).
    // Tight scientific math must render: NO$_2^-$, M$^{-1}$, $3.7 \times 10^5$.
    // Currency stays literal via two guards: the opener must not be followed
    // by whitespace ($ x is text), and a greedy span ending in whitespace is
    // rejected ($5 and $10's span "5 and " stays text); a digit may not
    // directly follow the closer either ($x$2 stays text).
    if (c === '$' || (c === '\\' && text[i + 1] === '(')) {
      const isParen = c === '\\'
      const openLen = isParen ? 2 : 1
      const closer = isParen ? '\\)' : '$'
      const start = i + openLen
      const end = text.indexOf(closer, start)
      if (end !== -1 && end > start) {
        const tex = text.slice(start, end)
        const nextOk = !/[ \t\n]/.test(text[start])
        const texOk = tex.trim() !== '' && !tex.includes('\n') && !/[ \t]$/.test(tex)
        const endOk = end + closer.length >= n || !/[0-9]/.test(text[end + closer.length])
        if (nextOk && texOk && endOk) {
          inlines.push(tex)
          out += INLINE_PH(inlines.length - 1)
          i = end + closer.length
          continue
        }
      }
      out += c
      i += 1
      continue
    }

    out += c
    i += 1
  }
  return { text: out, blocks, inlines }
}

// #endregion

// #region ===== 3. GFM block parser =====

/** List item marker at exactly `indent` (null when not a marker). */
function listMarkerAt(line, indent) {
  if (indentWidth(line) !== indent) return null
  const m = /^([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line.slice(indent))
  if (m === null) return null
  return {
    marker: m[1],
    content: m[3],
    contentIndent: indent + m[1].length + m[2].length,
  }
}

/** Split one table row into cells (respects leading/trailing/escaped pipes). */
function splitCells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** Whether a line is a GFM table delimiter row (cells of -/: only). */
function isDelimiterRow(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false
  const cells = splitCells(trimmed)
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
}

/** Whether lines[i] starts a GFM table (header + delimiter row). */
function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false
  if (isBlank(lines[i]) || !lines[i].includes('|')) return false
  return isDelimiterRow(lines[i + 1])
}

/** Block-level HTML start tags (GFM type-6 block list). */
const BLOCK_HTML_RE = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i

/** Whether the dedented line starts a new block (paragraph terminator). */
function isParagraphBreak(r, lines, i) {
  if (/^(?:`{3,}|~{3,})/.test(r)) return true
  if (/^#{1,6}(?:[ \t]|$)/.test(r)) return true
  if (/^(?:-{3,}|_{3,}|\*{3,})[ \t]*$/.test(r)) return true
  if (r.startsWith('>')) return true
  if (listMarkerAt(r, 0) !== null) return true
  if (r.startsWith('<') && BLOCK_HTML_RE.test(r)) return true
  if (r.includes('|') && isTableStart(lines, i)) return true
  return false
}

/**
 * Parse one list (items at exactly `indent`). Nested content re-enters
 * parseBlocks through the dedented item lines, so nesting is unbounded.
 * @returns {{token: object, i: number}}
 */
function parseList(lines, i, n, indent) {
  const items = []
  let ordered = null
  while (i < n) {
    const line = lines[i]
    if (isBlank(line)) {
      let j = i
      while (j < n && isBlank(lines[j])) j += 1
      if (j >= n) break
      if (listMarkerAt(lines[j], indent) !== null) { i = j; continue }
      break
    }
    if (indentWidth(line) !== indent) break
    const lm = listMarkerAt(line, indent)
    if (lm === null) break
    const ord = /^\d/.test(lm.marker)
    if (ordered === null) ordered = ord
    else if (ordered !== ord) break

    const contentIndent = lm.contentIndent
    const itemLines = [lm.content]
    i += 1
    while (i < n) {
      const l = lines[i]
      if (isBlank(l)) {
        let j = i
        while (j < n && isBlank(lines[j])) j += 1
        if (j >= n) break
        if (indentWidth(lines[j]) >= contentIndent) {
          while (i < j) { itemLines.push(''); i += 1 }
          continue
        }
        break
      }
      const ind2 = indentWidth(l)
      if (ind2 < indent) break
      if (ind2 === indent) {
        if (listMarkerAt(l, indent) !== null) break
        // Lazy continuation aligned under the marker.
        itemLines.push(l.slice(Math.min(contentIndent, ind2)))
        i += 1
        continue
      }
      itemLines.push(l.slice(contentIndent))
      i += 1
    }

    let task = null
    if (itemLines.length > 0) {
      const tm = /^\[( |x|X)\](?:[ \t]+(.*)|[ \t]*)$/.exec(itemLines[0])
      if (tm !== null) {
        task = tm[1].toLowerCase() === 'x'
        itemLines[0] = tm[2] ?? ''
      }
    }
    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1])) itemLines.pop()
    items.push({ task, tokens: parseBlocks(itemLines) })
  }
  return { token: { t: 'list', ordered: ordered === true, items }, i }
}

/** Parse one GFM table. @returns {{token: object, i: number}} */
function parseTable(lines, i, n) {
  const header = splitCells(lines[i])
  const delim = splitCells(lines[i + 1])
  const align = delim.map((d) => {
    const t = d.trim()
    const l = t.startsWith(':')
    const r = t.endsWith(':')
    return (l && r) ? 'c' : r ? 'r' : l ? 'l' : null
  })
  i += 2
  const rows = []
  while (i < n && !isBlank(lines[i]) && lines[i].includes('|')) {
    rows.push(splitCells(lines[i]))
    i += 1
  }
  const width = header.length
  const pad = (cells) => {
    const out = cells.slice(0, width)
    while (out.length < width) out.push('')
    return out
  }
  return { token: { t: 'table', align, header: pad(header), rows: rows.map(pad) }, i }
}

/**
 * Parse markdown lines into a block token tree.
 * @param lines - source lines (already math-protected).
 * @returns tokens: {t:'heading'|'code'|'hr'|'blockquote'|'list'|'table'|'html'|'para', ...}
 */
function parseBlocks(lines) {
  const tokens = []
  const n = lines.length
  let i = 0
  let blankSeen = true
  while (i < n) {
    const line = lines[i]
    if (isBlank(line)) { blankSeen = true; i += 1; continue }
    const indent = indentWidth(line)
    const rest = line.slice(indent)

    // Fenced code.
    if (indent <= 3 && /^(?:`{3,}|~{3,})/.test(rest)) {
      const fm = /^(`{3,}|~{3,})(.*)$/.exec(rest)
      const ch = fm[1][0]
      const len = fm[1].length
      const info = (fm[2] ?? '').trim()
      i += 1
      const code = []
      while (i < n) {
        const l = lines[i]
        const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}\\s*$`)
        if (closeRe.test(l)) { i += 1; break }
        code.push(l)
        i += 1
      }
      tokens.push({ t: 'code', lang: info, text: code.join('\n') })
      blankSeen = false
      continue
    }

    if (indent <= 3) {
      // ATX heading.
      const heading = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(rest)
      if (heading !== null) {
        const level = heading[1].length
        const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
        tokens.push({ t: 'heading', level, text })
        i += 1
        blankSeen = false
        continue
      }
      // Horizontal rule.
      if (/^(?:-{3,}|_{3,}|\*{3,})[ \t]*$/.test(rest)) {
        tokens.push({ t: 'hr' })
        i += 1
        blankSeen = false
        continue
      }
      // Blockquote.
      if (rest.startsWith('>')) {
        const body = []
        while (i < n) {
          const l = lines[i]
          const m = /^ {0,3}>[ \t]?(.*)$/.exec(l)
          if (m !== null) { body.push(m[1]); i += 1; continue }
          if (isBlank(l)) { body.push(''); i += 1; continue }
          break
        }
        tokens.push({ t: 'blockquote', children: parseBlocks(body) })
        blankSeen = false
        continue
      }
    }

    // List.
    if (listMarkerAt(line, indent) !== null) {
      const parsed = parseList(lines, i, n, indent)
      tokens.push(parsed.token)
      i = parsed.i
      blankSeen = false
      continue
    }

    // Indented code (needs a blank or non-paragraph before it).
    if (indent >= 4 && (blankSeen || tokens.length === 0 || tokens[tokens.length - 1].t !== 'para')) {
      const code = []
      while (i < n) {
        const l = lines[i]
        if (isBlank(l)) { code.push(''); i += 1; continue }
        if (indentWidth(l) < 4) break
        code.push(l.slice(4))
        i += 1
      }
      while (code.length > 0 && code[code.length - 1] === '') code.pop()
      tokens.push({ t: 'code', lang: '', text: code.join('\n') })
      blankSeen = false
      continue
    }

    // Table.
    if (isTableStart(lines, i)) {
      const parsed = parseTable(lines, i, n)
      tokens.push(parsed.token)
      i = parsed.i
      blankSeen = false
      continue
    }

    // Raw HTML block (collect until blank line; sanitized later).
    if (rest.startsWith('<') && BLOCK_HTML_RE.test(rest)) {
      const buf = [rest]
      i += 1
      while (i < n && !isBlank(lines[i])) {
        buf.push(lines[i].slice(indentWidth(lines[i])))
        i += 1
      }
      tokens.push({ t: 'html', text: buf.join('\n') })
      blankSeen = false
      continue
    }

    // Paragraph (with setext-heading lookahead on single-line paragraphs).
    const buf = [rest]
    i += 1
    let single = true
    while (i < n) {
      const l = lines[i]
      if (isBlank(l)) break
      const ind = indentWidth(l)
      const r = l.slice(ind >= 4 ? 4 : ind)
      // A setext underline ends a single-line paragraph (beats the hr rule).
      if (single && ind <= 3 && /^(?:=+|-+)[ \t]*$/.test(r)) break
      if (ind <= 3 && isParagraphBreak(r, lines, i)) break
      buf.push(r)
      i += 1
      single = false
    }
    if (single && i < n && !isBlank(lines[i])) {
      const s = lines[i].trim()
      if (/^=+[ \t]*$/.test(s)) {
        tokens.push({ t: 'heading', level: 1, text: buf[0] })
        i += 1
        blankSeen = false
        continue
      }
      if (/^-+[ \t]*$/.test(s)) {
        tokens.push({ t: 'heading', level: 2, text: buf[0] })
        i += 1
        blankSeen = false
        continue
      }
    }
    tokens.push({ t: 'para', text: buf.join('\n') })
    blankSeen = false
  }
  return tokens
}

// #endregion

// #region ===== 4. GFM inline renderer =====

const PUNCT_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

/** Whether ch is whitespace (includes newline forms). */
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

/** Whether ch is ASCII punctuation. */
function isPunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch)
}

/** CommonMark-style left-flanking test for an opener delimiter run. */
function leftFlanking(char, prev, next) {
  if (next === undefined || next === '\n') return false
  if (isWs(next)) return false
  if (isPunct(next) && !(isWs(prev) || isPunct(prev))) return false
  if (char === '_' && !isPunct(prev) && !isWs(prev) && !isPunct(next)) return false
  return true
}

/** CommonMark-style right-flanking test for a closer delimiter run. */
function rightFlanking(char, before, after) {
  if (isWs(before)) return false
  if (isPunct(before) && !(isWs(after) || isPunct(after))) return false
  if (char === '_' && !isPunct(before) && !isWs(before) && !isPunct(after) && !isWs(after)) return false
  return true
}

/** Only these link/image schemes pass: http:, https:, mailto:, fragments, relatives. */
function safeUrl(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('#')) return trimmed
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  if (m === null) return trimmed
  const scheme = m[1].toLowerCase()
  return (scheme === 'http' || scheme === 'https' || scheme === 'mailto') ? trimmed : null
}

/** Find the closing paren of a link destination (paren balancing). */
function findClosingParen(s, openIdx) {
  let depth = 0
  for (let j = openIdx; j < s.length; j += 1) {
    const ch = s[j]
    if (ch === '\\') { j += 1; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return -1
}

/** Split a link destination into {dest, title}; both null when malformed. */
function parseLinkDest(raw) {
  let s = raw.trim()
  if (s === '') return { dest: null, title: null }
  let dest
  if (s.startsWith('<')) {
    const gt = s.indexOf('>')
    if (gt === -1) return { dest: null, title: null }
    dest = s.slice(1, gt)
    s = s.slice(gt + 1).trim()
  } else {
    const m = /^(\S+?)(?:[ \t]+(.*))?$/.exec(s)
    dest = m[1]
    s = (m[2] ?? '').trim()
  }
  let title = null
  if (s !== '') {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('(') && s.endsWith(')'))) {
      title = s.slice(1, -1)
    } else {
      title = s
    }
  }
  return { dest, title }
}

/**
 * Render inline markdown to safe HTML. All text content is escaped; only the
 * renderer's own tags are emitted (plus verbatim raw inline HTML, which the
 * sanitizer cleans later).
 * @param text - inline markdown (may contain math placeholders).
 * @param opts - {root, mdPath} for image resolution.
 */
function renderInline(text, opts) {
  const src = text
  const out = []
  const stack = [] // delimiter openers: {char, len, idx}
  let i = 0
  const n = src.length

  const pushOpen = (char, len) => {
    stack.push({ char, len, idx: out.length })
  }

  const closeWith = (char, closeLen) => {
    let k = -1
    for (let x = stack.length - 1; x >= 0; x -= 1) {
      if (stack[x].char === char) { k = x; break }
    }
    if (k === -1) return 0
    const opener = stack[k]
    stack.length = k
    const use = Math.min(opener.len, closeLen)
    const inner = out.splice(opener.idx)
    let prefix = ''
    if (opener.len > use) prefix = escapeHtml(char.repeat(opener.len - use))
    const tag = use >= 2 ? 'strong' : 'em'
    out.push(`<${tag}>${prefix}${inner.join('')}</${tag}>`)
    return use
  }

  const flushLeftoverOpeners = () => {
    let offset = 0
    for (const entry of stack) {
      const lit = escapeHtml(entry.char.repeat(entry.len))
      const at = Math.min(entry.idx + offset, out.length)
      out.splice(at, 0, lit)
      offset += lit.length
    }
  }

  while (i < n) {
    const c = src[i]

    // Backslash escape.
    if (c === '\\' && i + 1 < n && isPunct(src[i + 1])) {
      out.push(escapeHtml(src[i + 1]))
      i += 2
      continue
    }

    // Hard break: two+ spaces before a newline.
    if (c === ' ') {
      let j = i
      while (j < n && src[j] === ' ') j += 1
      if (j - i >= 2 && (j >= n || src[j] === '\n')) {
        out.push('<br />')
        i = j
        continue
      }
      out.push(escapeHtml(src.slice(i, j)))
      i = j
      continue
    }

    // Code span.
    if (c === '`') {
      const len = runLen(src, i, '`')
      const close = findRun(src, i + len, '`', len)
      if (close !== -1) {
        let inner = src.slice(i + len, close).replace(/\n/g, ' ')
        if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
          inner = inner.slice(1, -1)
        }
        out.push(`<code>${escapeHtml(inner)}</code>`)
        i = close + len
        continue
      }
      out.push(escapeHtml(c.repeat(len)))
      i += len
      continue
    }

    // Image ![alt](src "title")
    if (c === '!' && src[i + 1] === '[') {
      const close = src.indexOf('](', i + 2)
      if (close !== -1) {
        const parenEnd = findClosingParen(src, close + 1)
        if (parenEnd !== -1) {
          const alt = src.slice(i + 2, close)
          const { dest, title } = parseLinkDest(src.slice(close + 2, parenEnd))
          if (dest !== null) {
            const safe = safeUrl(dest)
            if (safe !== null) {
              const res = resolveAssetUrl(opts && opts.mdPath ? opts.mdPath : '', safe)
              let target = null
              if (res.kind === 'absolute') target = res.url
              else if (res.kind === 'relative' && opts && opts.root) {
                target = rawUrl(opts.root, res.path, res.suffix)
              }
              if (target !== null) {
                const titleAttr = title !== null ? ` title="${escapeHtml(title)}"` : ''
                const srcEsc = escapeHtml(target).replace(/\s+/g, '%20')
                out.push(`<img src="${srcEsc}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" />`)
                i = parenEnd + 1
                continue
              }
              out.push(escapeHtml(alt))
              i = parenEnd + 1
              continue
            }
            out.push(escapeHtml(alt))
            i = parenEnd + 1
            continue
          }
        }
      }
      out.push('!')
      i += 1
      continue
    }

    // Link [text](href "title")
    if (c === '[') {
      const close = findLinkLabelClose(src, i)
      if (close !== -1 && src[close + 1] === '(') {
        const parenEnd = findClosingParen(src, close + 1)
        if (parenEnd !== -1) {
          const label = src.slice(i + 1, close)
          const { dest, title } = parseLinkDest(src.slice(close + 2, parenEnd))
          if (dest !== null) {
            const safe = safeUrl(dest)
            if (safe !== null) {
              const titleAttr = title !== null ? ` title="${escapeHtml(title)}"` : ''
              const isHttp = /^https?:/i.test(safe)
              const ext = isHttp ? ' target="_blank" rel="noopener noreferrer"' : ''
              out.push(`<a href="${escapeHtml(safe)}"${titleAttr}${ext}>${renderInline(label, opts)}</a>`)
              i = parenEnd + 1
              continue
            }
          }
        }
      }
      out.push('[')
      i += 1
      continue
    }

    // Autolink / raw inline HTML.
    if (c === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^<>\s]+)>/.exec(src.slice(i))
      if (auto !== null && safeUrl(auto[1]) !== null) {
        const ext = /^https?:/i.test(auto[1]) ? ' target="_blank" rel="noopener noreferrer"' : ''
        out.push(`<a href="${escapeHtml(auto[1])}"${ext}>${escapeHtml(auto[1])}</a>`)
        i += auto[0].length
        continue
      }
      const tag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>/.exec(src.slice(i))
      if (tag !== null) {
        out.push(tag[0])
        i += tag[0].length
        continue
      }
      out.push('&lt;')
      i += 1
      continue
    }

    // Strikethrough ~~...~~
    if (c === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close !== -1) {
        const inner = src.slice(i + 2, close)
        if (inner.trim() !== '' && !inner.includes('\n')) {
          out.push(`<del>${renderInline(inner, opts)}</del>`)
          i = close + 2
          continue
        }
      }
      out.push('~~')
      i += 2
      continue
    }

    // Emphasis delimiters * and _
    if (c === '*' || c === '_') {
      const len = runLen(src, i, c)
      const prev = i === 0 ? '\n' : src[i - 1]
      const next = src[i + len] !== undefined ? src[i + len] : '\n'
      const canOpen = leftFlanking(c, prev, next)
      const canClose = rightFlanking(c, prev, next)
      if (canClose) {
        const used = closeWith(c, len)
        if (used > 0) { i += used; continue }
      }
      if (canOpen) {
        pushOpen(c, len)
        i += len
        continue
      }
      out.push(escapeHtml(c.repeat(len)))
      i += len
      continue
    }

    out.push(escapeHtml(c))
    i += 1
  }
  flushLeftoverOpeners()
  return out.join('')
}

/**
 * Find the `]` closing a link label (bracket nesting), or -1.
 * Returns -1 when the next non-escape char after `]` is not `(`? No — the
 * caller checks the paren. This returns the bracket index.
 */
function findLinkLabelClose(src, openIdx) {
  let depth = 1
  for (let j = openIdx + 1; j < src.length; j += 1) {
    const ch = src[j]
    if (ch === '\\') { j += 1; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return -1
}

/** Strip inline markup for TOC labels and slugs. */
function plainTextOf(text) {
  let s = String(text)
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '')
  s = s.replace(/[*_~`]/g, '')
  s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
  s = s.replace(PH_RE, '')
  s = s.replace(/\s+/g, ' ')
  return s.trim()
}

/** GitHub-style heading slug (unicode-aware, punctuation stripped). */
function slugify(text) {
  let s = String(text).toLowerCase().trim()
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, '')
  s = s.replace(/\s+/g, '-')
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return s === '' ? 'section' : s
}

// #endregion

// #region ===== 5. HTML sanitizer =====

/** Tags dropped with all their content (active or structural danger). */
const DROP_TAGS = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'button', 'select', 'option', 'textarea', 'svg', 'math', 'video', 'audio', 'source', 'track', 'canvas', 'frame', 'frameset', 'applet', 'base', 'template', 'noscript', 'title', 'head'])

/** Tags preserved (children sanitized). */
const KEEP_TAGS = new Set(['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img', 'em', 'strong', 'del', 's', 'u', 'b', 'i', 'sub', 'sup', 'kbd', 'mark', 'small', 'input', 'details', 'summary', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'wbr'])

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const CLASS_TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/
/** Heading ids may be unicode (slugify emits \p{L}\p{N}_-: only). */
const ID_RE = /^[\p{L}\p{N}:_-]+$/u
const DIM_RE = /^\d{1,4}$/

/**
 * Sanitize rendered HTML through a DOMParser walk with a strict allowlist.
 * Raw HTML passthrough from the document is the only untrusted source; the
 * renderer's own output is escaped already — this is defense in depth.
 * @param html - the renderer's output.
 * @returns sanitized HTML (or the input when DOMParser is unavailable).
 */
function sanitizeHtml(html) {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<div id="mr-san">${html}</div>`, 'text/html')
  const source = doc.getElementById('mr-san')
  const out = doc.createElement('div')
  if (source !== null) sanitizeWalk(doc, source, out)
  return out.innerHTML
}

/** Recursive sanitizer walk. */
function sanitizeWalk(doc, node, out) {
  let child = node.firstChild
  while (child !== null) {
    const next = child.nextSibling
    if (child.nodeType === 3) {
      out.appendChild(doc.createTextNode(child.nodeValue))
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toLowerCase()
      if (DROP_TAGS.has(tag)) { child = next; continue }
      if (!KEEP_TAGS.has(tag)) {
        // Unknown inline-ish tag: unwrap, keep children.
        sanitizeWalk(doc, child, out)
        child = next
        continue
      }
      const el = doc.createElement(tag)
      if (tag === 'a') {
        const href = child.getAttribute('href')
        if (href !== null) {
          const safe = safeUrl(href)
          if (safe !== null) el.setAttribute('href', safe)
        }
        const title = child.getAttribute('title')
        if (title !== null) el.setAttribute('title', title)
        if (child.getAttribute('target') === '_blank' && (child.getAttribute('rel') ?? '').includes('noopener')) {
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noopener noreferrer')
        }
      } else if (tag === 'img') {
        const src = child.getAttribute('src')
        if (src !== null && (src.startsWith(`${RAW_ROUTE}?`) || /^https?:/i.test(src))) {
          el.setAttribute('src', src)
          const alt = child.getAttribute('alt')
          if (alt !== null) el.setAttribute('alt', alt)
          const title = child.getAttribute('title')
          if (title !== null) el.setAttribute('title', title)
          const w = child.getAttribute('width')
          if (w !== null && DIM_RE.test(w)) el.setAttribute('width', w)
          const h = child.getAttribute('height')
          if (h !== null && DIM_RE.test(h)) el.setAttribute('height', h)
          el.setAttribute('loading', 'lazy')
        } else {
          child = next
          continue // image with unsafe/missing src: drop entirely
        }
      } else if (tag === 'input') {
        if (child.getAttribute('type') !== 'checkbox') {
          child = next
          continue
        }
        el.setAttribute('type', 'checkbox')
        el.setAttribute('disabled', '')
        if (child.hasAttribute('checked')) el.setAttribute('checked', '')
      } else if (tag === 'th' || tag === 'td') {
        const align = child.getAttribute('align')
        if (align === 'left' || align === 'center' || align === 'right') el.setAttribute('align', align)
      } else if (tag === 'code' || tag === 'pre' || tag === 'li' || tag === 'div' || tag === 'span') {
        const cls = child.getAttribute('class')
        if (cls !== null) {
          const classes = cls.split(/\s+/).filter((c) => CLASS_TOKEN_RE.test(c))
          let allowed = []
          if (tag === 'code') allowed = classes.filter((c) => c.startsWith('language-'))
          else if (tag === 'pre') allowed = classes.filter((c) => c === 'mr-mermaid')
          else if (tag === 'li') allowed = classes.filter((c) => c === 'mr-task')
          else if (tag === 'div') allowed = classes.filter((c) => c === 'mr-task-row')
          else if (tag === 'span') allowed = classes.filter((c) => c === 'mr-task-body' || c.startsWith('mr-ph-'))
          if (allowed.length > 0) el.setAttribute('class', allowed.join(' '))
        }
      }
      if (HEADING_TAGS.has(tag)) {
        const id = child.getAttribute('id')
        if (id !== null && ID_RE.test(id)) el.setAttribute('id', id)
      }
      sanitizeWalk(doc, child, el)
      out.appendChild(el)
    }
    child = next
  }
}

// #endregion

// #region ===== 6. path / url resolution =====

/** Directory of a POSIX-style relative path ('' at root). */
function dirOf(filePath) {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? '' : filePath.slice(0, slash)
}

/** Collapse . and .. segments; null when .. escapes the base. */
function normalizeRel(rel) {
  const out = []
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** Percent-decode a path portion (best effort; never throws). */
function decodePart(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Resolve one markdown image src against the markdown file's location:
 * absolute URLs pass through; root-relative resolve from the project root;
 * other relatives resolve against the file's directory. `..` escaping the
 * root is rejected. Query/fragment suffixes survive for cache-busting srcs.
 */
function resolveAssetUrl(mdPath, src) {
  const trimmed = src.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'absolute', url: trimmed }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return { kind: 'absolute', url: trimmed }
  const decoded = decodePart(trimmed)
  const q = decoded.indexOf('?')
  const h = decoded.indexOf('#')
  let cut = decoded.length
  if (q !== -1) cut = Math.min(cut, q)
  if (h !== -1) cut = Math.min(cut, h)
  const pathPart = decoded.slice(0, cut)
  const suffix = decoded.slice(cut)
  const base = pathPart.startsWith('/') ? '' : dirOf(mdPath)
  const joined = base === '' ? pathPart : `${base}/${pathPart}`
  const normalized = normalizeRel(joined)
  if (normalized === null) return { kind: 'escape' }
  return { kind: 'relative', path: normalized, suffix }
}

/** The raw-file URL for a workspace-relative path. */
function rawUrl(root, path, suffix) {
  const rawSuffix = String(suffix ?? '')
  const hashAt = rawSuffix.indexOf('#')
  const beforeHash = hashAt === -1 ? rawSuffix : rawSuffix.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : rawSuffix.slice(hashAt)
  const query = beforeHash.startsWith('?') ? beforeHash.slice(1) : ''
  const cacheBust = query === '' ? '' : `&${query}`
  return `${RAW_ROUTE}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${cacheBust}${fragment}`
}

/** Whether a path looks like a markdown document. */
function isMarkdownPath(path) {
  const cleaned = String(path).replace(/\\/g, '/').split(/[?#]/)[0]
  return MD_EXT_RE.test(cleaned)
}

/** Resolve a relative link from one .md against another (anchor preserved). */
function resolveRelativeLink(fromMd, href) {
  const trimmed = String(href).trim().replace(/\\/g, '/')
  const hIdx = trimmed.indexOf('#')
  const beforeFragment = hIdx === -1 ? trimmed : trimmed.slice(0, hIdx)
  const qIdx = beforeFragment.indexOf('?')
  const pathPart = decodePart(qIdx === -1 ? beforeFragment : beforeFragment.slice(0, qIdx))
  const fragment = hIdx === -1 ? null : decodePart(trimmed.slice(hIdx + 1))
  if (pathPart === '') return fragment === null ? null : { path: null, fragment }
  const base = pathPart.startsWith('/') ? '' : dirOf(fromMd)
  const joined = base === '' ? pathPart.replace(/^\/+/, '') : `${base}/${pathPart}`
  const normalized = normalizeRel(joined)
  if (normalized === null) return null
  return { path: normalized, fragment }
}

/** Basename of a POSIX-style path. */
function basename(path) {
  const parts = String(path).split('/')
  return parts[parts.length - 1] || path
}

// #endregion

// #region ===== 7. KaTeX + Mermaid loaders =====

/** Bumped when the KaTeX renderer script finishes loading (triggers re-render). */
let katexVersion = 0
const katexReadyListeners = new Set()

// Preload KaTeX (JS + CSS) from the plugin's vendored assets served by the
// host half at /md-reader/assets/katex/* — fully offline, no CDN.
if (typeof document !== 'undefined' && typeof globalThis !== 'undefined' && globalThis.__mrKatexStarted === undefined) {
  globalThis.__mrKatexStarted = true
  const cssLink = document.createElement('link')
  cssLink.rel = 'stylesheet'
  cssLink.href = `${ASSET_BASE}/katex/katex.min.css`
  document.head.appendChild(cssLink)
  const script = document.createElement('script')
  script.src = `${ASSET_BASE}/katex/katex.min.js`
  script.onload = () => {
    katexVersion += 1
    for (const listener of katexReadyListeners) {
      try { listener() } catch { /* listener-owned */ }
    }
  }
  document.head.appendChild(script)
}

/** Render TeX through KaTeX; degrades to an escaped code span while absent. */
function renderKatex(tex, displayMode) {
  const katex = typeof globalThis !== 'undefined' ? globalThis.katex : undefined
  const pending = `<code class="mr-math-pending">${escapeHtml(tex)}</code>`
  if (katex === undefined || typeof katex.renderToString !== 'function') {
    return displayMode ? `<span class="mr-math-display">${pending}</span>` : pending
  }
  try {
    const rendered = katex.renderToString(tex, { displayMode, throwOnError: false, strict: false })
    // A span (styled block) — valid inside <p> when display math lands inline.
    return displayMode ? `<span class="mr-math-display">${rendered}</span>` : rendered
  } catch {
    return displayMode ? `<span class="mr-math-display">${pending}</span>` : pending
  }
}

/** Replace math placeholder spans with KaTeX HTML. */
function restoreMath(html, prot) {
  return html.replace(PH_DETAIL_RE, (ph, kind, idxStr) => {
    const display = kind === 'B'
    const idx = Number(idxStr)
    const tex = display ? prot.blocks[idx] : prot.inlines[idx]
    if (tex === undefined) return ''
    return renderKatex(tex, display)
  })
}

/** Whether the shell is in dark mode (the panel follows body[data-ds-dark-theme]). */
function themeIsDark() {
  return typeof document !== 'undefined' && document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
}

/** Current mermaid theme name. */
function mermaidTheme() {
  return themeIsDark() ? 'dark' : 'default'
}

/** Whether the optional mermaid drop-in exists on the host (no 404 noise). */
async function mermaidAssetExists(url) {
  try {
    // Probe with HEAD; hosts without HEAD support answer 405/501, then a GET
    // probe settles it (the file is only fetched once per page load).
    const head = await fetch(url, { method: 'HEAD' })
    if (head.ok) return true
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, { method: 'GET' })
      return get.ok
    }
    return false
  } catch {
    return false
  }
}

/** Memoized mermaid.min.js loader (drop-in vendor asset; null when absent). */
let mermaidPromise = null
function loadMermaid() {
  if (mermaidPromise !== null) return mermaidPromise
  mermaidPromise = (async () => {
    if (typeof globalThis !== 'undefined' && typeof globalThis.mermaid === 'object' && globalThis.mermaid !== null) {
      return globalThis.mermaid
    }
    const url = `${ASSET_BASE}/mermaid/mermaid.min.js`
    // Probe before injecting the script tag: an absent drop-in must degrade
    // silently instead of printing a 404 to the console.
    if (!(await mermaidAssetExists(url))) return null
    return await new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = url
      script.onload = () => {
        resolve(typeof globalThis.mermaid === 'object' ? globalThis.mermaid : null)
      }
      script.onerror = () => resolve(null)
      document.head.appendChild(script)
    })
  })()
  return mermaidPromise
}

/** Initialize the mermaid renderer once per theme. */
function initMermaid(mermaid, theme) {
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
  } catch {
    // older/newer option shapes: a failed initialize falls back to defaults
  }
}

let mermaidDiagramSeq = 0
let mermaidInitializedTheme = null

/**
 * Render every mermaid block inside `container` (async). Idempotent: previous
 * rendered diagrams are dropped and source blocks reset first, so re-render
 * passes (theme changes, KaTeX-tick re-renders) never stack duplicates.
 * Without the vendor drop-in the blocks degrade into a styled source view.
 */
async function renderMermaidIn(container, note) {
  if (container === null) return
  for (const div of Array.from(container.querySelectorAll('.mr-mermaid-render'))) div.remove()
  for (const pre of Array.from(container.querySelectorAll('pre.mr-mermaid'))) {
    pre.style.display = ''
    pre.classList.remove('mr-mermaid-fallback')
  }
  const mermaid = await loadMermaid()
  const pres = Array.from(container.querySelectorAll('pre.mr-mermaid'))
  for (const pre of pres) {
    const code = pre.querySelector('code')
    if (code === null) continue
    if (mermaid === null) {
      pre.classList.add('mr-mermaid-fallback')
      pre.dataset.note = note
      continue
    }
    const src = code.textContent ?? ''
    if (src.trim() === '') {
      pre.classList.add('mr-mermaid-fallback')
      pre.dataset.note = note
      continue
    }
    if (mermaidInitializedTheme !== mermaidTheme()) {
      initMermaid(mermaid, mermaidTheme())
      mermaidInitializedTheme = mermaidTheme()
    }
    try {
      const id = `mrdiagram${mermaidDiagramSeq}`
      mermaidDiagramSeq += 1
      let out = mermaid.render(id, src)
      if (out !== null && typeof out === 'object' && typeof out.then === 'function') out = await out
      if (out === null || typeof out !== 'object' || typeof out.svg !== 'string') {
        pre.classList.add('mr-mermaid-fallback')
        pre.dataset.note = note
        continue
      }
      const div = document.createElement('div')
      div.className = 'mr-mermaid-render'
      div.innerHTML = out.svg // mermaid strict-mode output (sanitized by mermaid)
      pre.style.display = 'none'
      pre.after(div)
    } catch {
      pre.classList.add('mr-mermaid-fallback')
      pre.dataset.note = note
    }
  }
}

/** Remove rendered diagrams and re-render (theme change / re-render pass). */
function refreshMermaid(container, note) {
  return renderMermaidIn(container, note)
}

// #endregion

// #region ===== 8. i18n =====

const STRINGS = {
  zh: {
    panelBtn: '阅读模式',
    panelBtnTitle: '在 Markdown 阅读器中打开当前文件',
    floatTitle: 'Markdown 阅读器',
    outline: '目录',
    noOutline: '本文档没有标题',
    fontSize: '字号',
    refresh: '刷新',
    theme: '主题',
    close: '关闭',
    openFile: '打开文件',
    pickerTitle: '打开 Markdown 文件',
    pickerPlaceholder: '输入工作区相对路径，如 docs/guide.md',
    pickerHint: '支持 .md / .markdown / .mdx；Enter 打开，Esc 关闭',
    recent: '最近打开',
    noRecent: '暂无最近打开的文件',
    notFound: '文件不存在或不可访问',
    workspaceUnknown: '项目根目录未注册或不可访问',
    notMarkdown: '不是 Markdown 文件',
    network: '网络请求失败',
    loadError: '读取失败',
    retry: '重试',
    loading: '正在渲染…',
    mermaidFallback: 'Mermaid 渲染器未安装（离线环境）——将 mermaid.min.js 放入插件 vendor/mermaid/ 目录即可渲染图表',
    pathInputTitle: '输入相对路径后按 Enter 打开',
    truncated: '文件过大，仅显示前 4MB',
    noProject: '当前会话没有绑定工作目录',
    fileChanged: '文件已在外部更新',
    fileUnavailable: '文件已被移动、删除或暂时不可访问',
    reloadNow: '立即载入新版',
    autoReload: '自动重载',
    updatedAt: '更新于',
    readingTime: '预计阅读',
    minute: '分钟',
    copyCode: '复制',
    copied: '已复制',
    collapseCode: '折叠代码',
    expandCode: '展开代码',
    collapseSection: '折叠长章节',
    expandSection: '展开章节',
    zoomImage: '查看大图',
    downloadImage: '下载图片',
    reloadFailed: '刷新失败',
  },
  en: {
    panelBtn: 'Read',
    panelBtnTitle: 'Open the current file in the Markdown reader',
    floatTitle: 'Markdown reader',
    outline: 'Outline',
    noOutline: 'No headings in this document',
    fontSize: 'Font size',
    refresh: 'Refresh',
    theme: 'Theme',
    close: 'Close',
    openFile: 'Open file',
    pickerTitle: 'Open a Markdown file',
    pickerPlaceholder: 'Workspace-relative path, e.g. docs/guide.md',
    pickerHint: '.md / .markdown / .mdx — Enter to open, Esc to close',
    recent: 'Recent',
    noRecent: 'No recent files',
    notFound: 'File not found or not accessible',
    workspaceUnknown: 'Project root not registered or not accessible',
    notMarkdown: 'Not a Markdown file',
    network: 'Network request failed',
    loadError: 'Load failed',
    retry: 'Retry',
    loading: 'Rendering…',
    mermaidFallback: 'Mermaid renderer not installed (offline) — drop mermaid.min.js into the plugin vendor/mermaid/ directory to render diagrams',
    pathInputTitle: 'Type a relative path and press Enter to open',
    truncated: 'File too large — showing the first 4MB',
    noProject: 'The current session has no workspace directory',
    fileChanged: 'This file changed outside the reader',
    fileUnavailable: 'This file was moved, deleted, or is temporarily unavailable',
    reloadNow: 'Load latest version',
    autoReload: 'Auto reload',
    updatedAt: 'Updated',
    readingTime: 'Reading time',
    minute: 'min',
    copyCode: 'Copy',
    copied: 'Copied',
    collapseCode: 'Collapse code',
    expandCode: 'Expand code',
    collapseSection: 'Collapse long section',
    expandSection: 'Expand section',
    zoomImage: 'View full image',
    downloadImage: 'Download image',
    reloadFailed: 'Reload failed',
  },
}

let currentLang = 'en'
function detectLang() {
  if (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.lang === 'string') {
    currentLang = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
}
/** Translate one key. */
function t(key) {
  const table = STRINGS[currentLang] ?? STRINGS.en
  return table[key] ?? STRINGS.en[key] ?? key
}

// #endregion

// #region ===== 9. host API + persistence =====

/**
 * POST /md-reader/read — one gated markdown read.
 * @returns {ok:true, value:{content,mtime,size,truncated}} | {ok:false, error:{code,message}}
 */
async function apiRead(root, path) {
  try {
    const res = await fetch(READ_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path }),
    })
    if (!res.ok) {
      let error = { code: `http-${res.status}`, message: `HTTP ${res.status}` }
      try {
        const env = await res.json()
        if (env !== null && typeof env === 'object' && env.ok === false && env.error !== null && typeof env.error === 'object') {
          error = { code: String(env.error.code ?? error.code), message: String(env.error.message ?? error.message) }
        }
      } catch { /* non-JSON error body */ }
      return { ok: false, error }
    }
    const env = await res.json()
    if (env !== null && typeof env === 'object' && env.ok === true) {
      return { ok: true, value: env.value }
    }
    return { ok: false, error: { code: 'internal', message: 'bad envelope' } }
  } catch (err) {
    return { ok: false, error: { code: 'network', message: String((err && err.message) || err) } }
  }
}

/** POST /md-reader/stat — metadata-only change check. */
async function apiStat(root, path) {
  try {
    const res = await fetch(STAT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path }),
    })
    let env = null
    try { env = await res.json() } catch { /* non-JSON response */ }
    if (res.ok && env !== null && typeof env === 'object' && env.ok === true) {
      return { ok: true, value: env.value }
    }
    const fallback = { code: `http-${res.status}`, message: `HTTP ${res.status}` }
    const error = env !== null && typeof env === 'object' && env.ok === false && env.error !== null && typeof env.error === 'object'
      ? { code: String(env.error.code ?? fallback.code), message: String(env.error.message ?? fallback.message) }
      : fallback
    return { ok: false, error }
  } catch (err) {
    return { ok: false, error: { code: 'network', message: String((err && err.message) || err) } }
  }
}

/** Map a host error code to a user-facing message. */
function mapError(error) {
  const code = error && error.code
  if (code === 'not-found') return t('notFound')
  if (code === 'workspace-unknown' || code === 'path-outside-root') return t('workspaceUnknown')
  if (code === 'unsupported-type') return t('notMarkdown')
  if (code === 'network') return t('network')
  if (code === 'too-large') return t('truncated')
  return error && error.message ? String(error.message) : t('loadError')
}

/** JSON read with fallback (localStorage may be unavailable). */
function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** JSON write, quota failures degrade silently. */
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* best-effort */ }
}

/** Recent files for one root (sanitized, capped). */
function getRecent(root) {
  const list = readJson(`${RECENT_KEY_PREFIX}${root}`, [])
  if (!Array.isArray(list)) return []
  return list
    .filter((e) => e !== null && typeof e === 'object' && typeof e.path === 'string' && e.path !== '')
    .map((e) => ({ path: e.path, at: typeof e.at === 'number' ? e.at : 0 }))
    .slice(0, RECENT_CAP)
}

/** Record one successful open (dedup, LRU). */
function pushRecent(root, path) {
  const cur = getRecent(root).filter((e) => e.path !== path)
  cur.unshift({ path, at: Date.now() })
  writeJson(`${RECENT_KEY_PREFIX}${root}`, cur.slice(0, RECENT_CAP))
}

/** Reader UI prefs per root (font size, outline visibility, live reload). */
function getUi(root) {
  const v = readJson(`${UI_KEY_PREFIX}${root}`, {})
  let fontSize = FONT_DEFAULT
  let outlineOpen = true
  let autoReload = false
  if (v !== null && typeof v === 'object') {
    if (typeof v.fontSize === 'number') fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v.fontSize)))
    if (typeof v.outlineOpen === 'boolean') outlineOpen = v.outlineOpen
    if (typeof v.autoReload === 'boolean') autoReload = v.autoReload
  }
  return { fontSize, outlineOpen, autoReload }
}

/** Persist reader UI prefs. */
function setUi(root, patch) {
  writeJson(`${UI_KEY_PREFIX}${root}`, { ...getUi(root), ...patch })
}

// #endregion

// #region ===== render pipeline (blocks -> html) =====

/** Collect heading tokens in document order (into blockquote/list children too). */
function collectHeadings(tokens, out) {
  for (const token of tokens) {
    if (token.t === 'heading') out.push(token)
    else if (token.t === 'blockquote') collectHeadings(token.children, out)
    else if (token.t === 'list') {
      for (const item of token.items) collectHeadings(item.tokens, out)
    }
  }
}

/** Render one block token to HTML. */
function renderBlock(token, opts, ctx) {
  switch (token.t) {
    case 'heading': {
      const id = ctx.headingIds.get(token) ?? ''
      return `<h${token.level} id="${escapeHtml(id)}">${renderInline(token.text, opts)}</h${token.level}>`
    }
    case 'code': {
      const langAttr = token.lang !== '' ? ` class="language-${escapeHtml(token.lang)}"` : ''
      const mermaid = /^mermaid([\s-]|$)/i.test(token.lang)
      const preClass = mermaid ? ' class="mr-mermaid"' : ''
      return `<pre${preClass}><code${langAttr}>${escapeHtml(token.text)}</code></pre>`
    }
    case 'hr':
      return '<hr />'
    case 'blockquote':
      return `<blockquote>${token.children.map((c) => renderBlock(c, opts, ctx)).join('\n')}</blockquote>`
    case 'list': {
      const tag = token.ordered ? 'ol' : 'ul'
      const items = token.items.map((item) => {
        const body = item.tokens.map((c) => renderBlock(c, opts, ctx)).join('\n')
        if (item.task !== null) {
          return `<li class="mr-task"><div class="mr-task-row"><input type="checkbox" disabled${item.task ? ' checked' : ''} /><span class="mr-task-body">${body}</span></div></li>`
        }
        return `<li>${body}</li>`
      }).join('\n')
      return `<${tag}>${items}</${tag}>`
    }
    case 'table': {
      const head = token.header
        .map((cell, idx) => `<th${token.align[idx] ? ` align="${token.align[idx]}"` : ''}>${renderInline(cell, opts)}</th>`)
        .join('')
      const body = token.rows
        .map((row) => `<tr>${row.map((cell, idx) => `<td${token.align[idx] ? ` align="${token.align[idx]}"` : ''}>${renderInline(cell, opts)}</td>`).join('')}</tr>`)
        .join('')
      return `<table><thead><tr>${head}</tr></thead>${token.rows.length > 0 ? `<tbody>${body}</tbody>` : ''}</table>`
    }
    case 'html':
      return token.text
    case 'para':
      // A paragraph that is exactly one display-math placeholder renders as
      // a standalone block (no <p> wrapper).
      if (/^<span class="mr-ph-B\d+"><\/span>$/.test(token.text)) return token.text
      return `<p>${renderInline(token.text, opts)}</p>`
    default:
      return ''
  }
}

/**
 * The whole pipeline: math protect → block parse → heading slugs → render →
 * sanitize → math restore.
 * @param source - raw markdown.
 * @param opts - {root, mdPath} (image resolution context).
 * @returns {{html: string, toc: Array<{level:number, id:string, label:string}>}}
 */
function renderDocument(source, opts) {
  const safeOpts = opts ?? {}
  const prot = protectMath(source)
  const tokens = parseBlocks(prot.text.split('\n'))
  const headings = []
  collectHeadings(tokens, headings)

  const used = new Map()
  const headingIds = new Map()
  for (const token of headings) {
    const base = slugify(plainTextOf(token.text))
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    headingIds.set(token, count === 0 ? base : `${base}-${count}`)
  }

  const ctx = { headingIds }
  const html = tokens.map((token) => renderBlock(token, safeOpts, ctx)).join('\n')
  const clean = sanitizeHtml(html)
  const final = restoreMath(clean, prot)
  const toc = headings.map((token) => ({
    level: token.level,
    id: headingIds.get(token) ?? '',
    label: plainTextOf(token.text) || '···',
  }))
  return { html: final, toc }
}

// #endregion

// #region ===== 10. React reader UI =====

// ---- tiny hyperscript helper (no JSX in this bundle) ----
// ReactLib is set at apply time from the shell's module table (the factory's
// require); the UI section only renders after apply has run.
let ReactLib = null

function h(type, props, ...children) {
  const attrs = props ?? {}
  const kids = []
  const flat = (c) => {
    if (Array.isArray(c)) { c.forEach(flat); return }
    if (c !== null && c !== undefined && c !== false) kids.push(c)
  }
  children.forEach(flat)
  return ReactLib.createElement(type, attrs, ...kids)
}

// ---- inline SVG icons (16px viewBox, currentColor stroke) ----
const ICONS = {
  book: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1H7v12H3.5A1.5 1.5 0 0 0 2 14.5z"/><path d="M14 2.5A1.5 1.5 0 0 0 12.5 1H9v12h3.5A1.5 1.5 0 0 1 14 14.5z"/><path d="M2 14.5V13a1 1 0 0 1 1-1h4"/><path d="M14 14.5V13a1 1 0 0 0-1-1H9"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="1.5" cy="4" r="0.01"/></svg>',
  minus: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.8 1.8v2.9h-2.9"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3l1.5 2h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>',
  palette: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13h1a1.5 1.5 0 0 0 0-3h-.7a1.7 1.7 0 0 1 0-3.4H9A3.5 3.5 0 0 0 8 1.5z"/><circle cx="5" cy="5.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="11" cy="3.6" r="0.9" fill="currentColor" stroke="none"/><circle cx="13.4" cy="7.4" r="0.9" fill="currentColor" stroke="none"/></svg>',
}

/** The reader stylesheet (injected once per apply). */
const READER_CSS = `
#mr-root, #mr-root * { box-sizing: border-box; }
/* Theme variables live on #mr-root (NOT .mr-overlay) so siblings like the
   floating button inherit them too. */
#mr-root {
  --mr-bg: #f6f0e2; --mr-bg-2: #efe7d3; --mr-bg-3: #e5dabf;
  --mr-text: #3c352a; --mr-text-2: #6e6453; --mr-text-3: #988c74;
  --mr-border: #ddd0b3; --mr-accent: #0969da; --mr-code-bg: #f0e8d5;
  --mr-table-head: #efe7d3; --mr-quote: #6e6453;
  --mr-paper: #faf4e5;
  --mr-paper-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
}
body[data-ds-dark-theme] #mr-root {
  --mr-bg: #0d1117; --mr-bg-2: #161b22; --mr-bg-3: #21262d;
  --mr-text: #e6edf3; --mr-text-2: #a5b0bb; --mr-text-3: #7d8590;
  --mr-border: #30363d; --mr-accent: #4493f8; --mr-code-bg: #161b22;
  --mr-table-head: #161b22; --mr-quote: #a5b0bb;
  --mr-paper: #0e1116;
  --mr-paper-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.07'/%3E%3C/svg%3E");
}
.mr-overlay {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--mr-bg); color: var(--mr-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
}
.mr-overlay.mr-hidden { display: none; }
.mr-header {
  display: flex; align-items: center; gap: 8px; height: 44px; flex: none;
  padding: 0 12px; background: var(--mr-bg-2); border-bottom: 1px solid var(--mr-border);
}
.mr-progress-track { height: 2px; flex: none; background: var(--mr-border); overflow: hidden; }
.mr-progress-bar { height: 100%; background: var(--mr-accent); transition: width 120ms linear; }
.mr-live-banner {
  min-height: 38px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 6px 14px; border-bottom: 1px solid var(--mr-border);
  background: var(--mr-bg-2); background: color-mix(in srgb, var(--mr-accent) 10%, var(--mr-bg-2)); color: var(--mr-text);
}
.mr-live-banner-text { flex: 1; min-width: 0; font-size: 12px; }
.mr-auto-reload { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--mr-text-2); cursor: pointer; }
.mr-doc-meta { white-space: nowrap; font-size: 11px; color: var(--mr-text-3); }
.mr-title { font-weight: 600; font-size: 14px; white-space: nowrap; }
.mr-path {
  flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; color: var(--mr-text-2); background: transparent;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 8px;
}
.mr-path:hover { border-color: var(--mr-border); }
.mr-path:focus { border-color: var(--mr-accent); outline: none; color: var(--mr-text); }
.mr-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--mr-text-2); cursor: pointer;
}
.mr-icon-btn:hover { background: var(--mr-bg-3); color: var(--mr-text); }
.mr-icon-btn:disabled { opacity: 0.35; cursor: default; }
.mr-body { flex: 1 1 auto; display: flex; min-height: 0; overflow: hidden; }
.mr-outline {
  width: 240px; flex: 0 0 auto; height: 100%; min-height: 0; overflow-y: auto;
  padding: 10px 8px 24px;
  border-right: 1px solid var(--mr-border); background: var(--mr-bg-2);
}
.mr-outline-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;
  color: var(--mr-text-3); padding: 2px 8px 8px;
}
.mr-outline-item {
  display: block; padding: 3px 8px; margin: 0; border-radius: 6px; border: none;
  background: transparent; width: 100%; text-align: left;
  font-size: 13px; line-height: 1.5; color: var(--mr-text-2); cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mr-outline-item:hover { background: var(--mr-bg-3); color: var(--mr-text); }
.mr-outline-item.mr-active { color: var(--mr-accent); font-weight: 600; }
.mr-outline-empty { font-size: 12px; color: var(--mr-text-3); padding: 0 8px; }
.mr-scroll {
  flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0;
  overflow-y: auto; overscroll-behavior: contain;
  background-color: var(--mr-paper, #faf4e5);
  background-image: var(--mr-paper-grain, none);
  background-attachment: local;
}
.mr-doc {
  max-width: 900px; margin: 0 auto; padding: 28px 40px 96px;
  font-size: 16px; line-height: 1.7; word-break: break-word;
}
.mr-doc h1, .mr-doc h2 { border-bottom: 1px solid var(--mr-border); padding-bottom: 0.3em; }
.mr-doc h1 { font-size: 2em; margin: 24px 0 16px; }
.mr-doc h2 { font-size: 1.5em; margin: 24px 0 16px; }
.mr-doc h3 { font-size: 1.25em; margin: 24px 0 16px; }
.mr-doc h4 { font-size: 1em; margin: 24px 0 16px; }
.mr-doc h5 { font-size: 0.875em; margin: 24px 0 16px; }
.mr-doc h6 { font-size: 0.85em; margin: 24px 0 16px; color: var(--mr-text-2); }
.mr-doc h1:first-child, .mr-doc h2:first-child, .mr-doc h3:first-child { margin-top: 0; }
.mr-doc p { margin: 0 0 16px; }
.mr-doc a { color: var(--mr-accent); text-decoration: none; }
.mr-doc a:hover { text-decoration: underline; }
.mr-doc ul, .mr-doc ol { margin: 0 0 16px; padding-left: 2em; }
.mr-doc li { margin: 4px 0; }
.mr-doc li > ul, .mr-doc li > ol { margin: 4px 0 8px; }
.mr-doc blockquote {
  margin: 0 0 16px; padding: 0 1em; color: var(--mr-quote);
  border-left: 4px solid var(--mr-border);
}
.mr-doc blockquote p { margin-bottom: 8px; }
.mr-doc code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.85em; background: var(--mr-code-bg); border-radius: 6px; padding: 0.15em 0.4em;
}
.mr-doc pre {
  background: var(--mr-code-bg); border-radius: 8px; padding: 14px 16px;
  overflow-x: auto; margin: 0 0 16px;
}
.mr-doc pre code { display: block; background: none; padding: 0; font-size: 13px; line-height: 1.55; }
.mr-code-wrap { margin: 0 0 16px; border: 1px solid var(--mr-border); border-radius: 8px; overflow: hidden; background: var(--mr-code-bg); }
.mr-code-wrap pre { margin: 0; border-radius: 0; border: none; padding: 10px 0 12px; }
.mr-code-toolbar { display: flex; align-items: center; gap: 4px; min-height: 32px; padding: 3px 7px 3px 12px; border-bottom: 1px solid var(--mr-border); color: var(--mr-text-3); }
.mr-code-language { flex: 1; min-width: 0; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; }
.mr-code-action { border: none; border-radius: 5px; padding: 3px 7px; background: transparent; color: var(--mr-text-2); font: inherit; font-size: 11px; line-height: 1.4; cursor: pointer; }
.mr-code-action:hover { background: var(--mr-bg-3); color: var(--mr-text); }
.mr-code-line { display: block; min-width: max-content; padding: 0 16px 0 0; }
.mr-code-line::before { content: attr(data-line); display: inline-block; width: 3.5em; margin-right: 14px; padding-right: 10px; border-right: 1px solid var(--mr-border); color: var(--mr-text-3); text-align: right; user-select: none; }
.mr-code-wrap.mr-code-collapsed pre { display: none; }
.mr-doc table {
  border-collapse: separate; border-spacing: 0; margin: 0; width: max-content; min-width: 100%;
}
.mr-doc th, .mr-doc td { border: 1px solid var(--mr-border); padding: 6px 13px; }
.mr-doc th { position: sticky; top: 0; z-index: 1; background: var(--mr-table-head); font-weight: 600; }
.mr-table-wrap { max-width: 100%; max-height: min(68vh, 620px); margin: 0 0 16px; overflow: auto; border-radius: 6px; }
.mr-doc img { max-width: 100%; border-radius: 6px; cursor: zoom-in; }
.mr-doc img:focus { outline: 2px solid var(--mr-accent); outline-offset: 3px; }
.mr-doc h1, .mr-doc h2, .mr-doc h3, .mr-doc h4 { position: relative; }
.mr-section-toggle { position: absolute; right: 0; top: 0.15em; width: 24px; height: 24px; border: 1px solid var(--mr-border); border-radius: 50%; background: var(--mr-bg-2); color: var(--mr-text-2); line-height: 20px; cursor: pointer; opacity: 0; transition: opacity 120ms; }
.mr-doc h1:hover > .mr-section-toggle, .mr-doc h2:hover > .mr-section-toggle, .mr-doc h3:hover > .mr-section-toggle, .mr-doc h4:hover > .mr-section-toggle, .mr-section-toggle:focus { opacity: 1; }
.mr-doc hr { border: none; border-top: 1px solid var(--mr-border); margin: 24px 0; }
.mr-doc kbd {
  background: var(--mr-bg-3); border: 1px solid var(--mr-border); border-bottom-width: 2px;
  border-radius: 6px; padding: 0 6px; font-size: 0.85em; font-family: inherit;
}
.mr-doc li.mr-task { list-style: none; }
.mr-task-row { display: flex; gap: 8px; align-items: flex-start; }
.mr-task-row input { margin-top: 6px; }
.mr-task-row p { margin-bottom: 8px; }
.mr-math-display { display: block; margin: 16px 0; overflow-x: auto; text-align: center; }
.mr-math-pending { background: var(--mr-code-bg); color: var(--mr-text-2); }
pre.mr-mermaid { border: 1px dashed var(--mr-border); }
pre.mr-mermaid-fallback::before {
  content: attr(data-note); display: block; font-size: 11px; line-height: 1.6;
  color: var(--mr-text-3); border-bottom: 1px dashed var(--mr-border);
  padding: 6px 0 6px 0; margin-bottom: 10px;
}
.mr-mermaid-render { text-align: center; padding: 16px; margin: 0 0 16px; border-radius: 8px; overflow-x: auto; background: var(--mr-bg); }
.mr-mermaid-render svg { max-width: 100%; height: auto; }
.mr-float-btn {
  position: fixed; right: 16px; bottom: 16px; width: 42px; height: 42px;
  border-radius: 50%; border: 1px solid var(--mr-border, #ddd0b3);
  background: var(--mr-bg-2, #efe7d3); color: var(--mr-text-2, #6e6453);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  z-index: 150; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
.mr-float-btn:hover { color: var(--mr-accent, #0969da); border-color: var(--mr-accent, #0969da); }
.mr-picker { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--mr-bg); }
.mr-picker-card { width: 460px; max-width: calc(100vw - 48px); display: flex; flex-direction: column; gap: 12px; }
.mr-picker-title { font-size: 15px; font-weight: 600; }
.mr-picker-input {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px;
  padding: 8px 10px; border: 1px solid var(--mr-border); border-radius: 8px;
  background: var(--mr-bg); color: var(--mr-text);
}
.mr-picker-input:focus { outline: none; border-color: var(--mr-accent); }
.mr-picker-recent-title { font-size: 12px; color: var(--mr-text-3); }
.mr-picker-recent { display: flex; flex-direction: column; border: 1px solid var(--mr-border); border-radius: 8px; overflow: hidden; }
.mr-picker-recent-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 10px; font-size: 13px; border: none; border-bottom: 1px solid var(--mr-border);
  background: transparent; color: var(--mr-text); text-align: left; cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.mr-picker-recent-item:last-child { border-bottom: none; }
.mr-picker-recent-item:hover { background: var(--mr-bg-3); }
.mr-picker-recent-item-time { font-size: 11px; color: var(--mr-text-3); font-family: inherit; flex: none; }
.mr-picker-hint { font-size: 12px; color: var(--mr-text-3); }
.mr-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--mr-text-2); }
.mr-error-title { font-size: 15px; font-weight: 600; color: var(--mr-text); }
.mr-error-msg { font-size: 13px; max-width: 480px; text-align: center; }
.mr-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
  border: 1px solid var(--mr-border); border-radius: 6px; background: var(--mr-bg-2);
  color: var(--mr-text); font-size: 13px; cursor: pointer;
}
.mr-btn:hover { border-color: var(--mr-accent); color: var(--mr-accent); }
.mr-lightbox { position: fixed; inset: 0; z-index: 2100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px; background: rgba(0, 0, 0, 0.86); }
.mr-lightbox img { max-width: min(96vw, 1800px); max-height: calc(100vh - 100px); object-fit: contain; box-shadow: 0 12px 60px rgba(0,0,0,.45); }
.mr-lightbox-actions { display: flex; align-items: center; gap: 8px; }
.mr-lightbox .mr-btn { background: #20242a; border-color: #4b5563; color: #fff; text-decoration: none; }
@keyframes mr-spin { to { transform: rotate(360deg); } }
.mr-spinner {
  width: 30px; height: 30px; border-radius: 50%;
  border: 3px solid var(--mr-border); border-top-color: var(--mr-accent);
  animation: mr-spin 0.8s linear infinite;
}
.mr-read-btn {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  height: 24px; padding: 0 8px; border-radius: 6px;
  border: 1px solid #d1d5db; background: transparent; color: #57606a;
  font-size: 12px; cursor: pointer; font-family: inherit; line-height: 1;
}
.mr-read-btn:hover { color: #0969da; border-color: #0969da; }
body[data-ds-dark-theme] .mr-read-btn { border-color: #3f4a57; color: #9aa7b4; }
body[data-ds-dark-theme] .mr-read-btn:hover { color: #4493f8; border-color: #4493f8; }
@media (max-width: 720px) {
  .mr-doc { padding: 22px 18px 80px; }
  .mr-outline { width: 190px; }
  .mr-doc-meta { display: none; }
}
`

// ---- reader themes ---------------------------------------------------------
// Each theme defines light + dark palettes for the --mr-* custom properties.
// The active theme's variables are emitted into a dedicated <style> element
// (#dsh-markdown-reader-theme) that overrides the warm-paper defaults baked
// into READER_CSS above; the body[data-ds-dark-theme] selector switches
// palettes automatically when the GUI toggles dark mode.

/** One feTurbulence paper-grain data URI at a given opacity. */
const grainSvg = (opacity) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='${opacity}'/%3E%3C/svg%3E")`

/** The theme registry (iteration order = cycling order). */
const READER_THEMES = {
  warm: {
    label: '暖纸',
    light: {
      '--mr-bg': '#f6f0e2', '--mr-bg-2': '#efe7d3', '--mr-bg-3': '#e5dabf',
      '--mr-text': '#3c352a', '--mr-text-2': '#6e6453', '--mr-text-3': '#988c74',
      '--mr-border': '#ddd0b3', '--mr-accent': '#0969da', '--mr-code-bg': '#f0e8d5',
      '--mr-table-head': '#efe7d3', '--mr-quote': '#6e6453',
      '--mr-paper': '#faf4e5', '--mr-paper-grain': grainSvg('0.05'),
    },
    dark: {
      '--mr-bg': '#0d1117', '--mr-bg-2': '#161b22', '--mr-bg-3': '#21262d',
      '--mr-text': '#e6edf3', '--mr-text-2': '#a5b0bb', '--mr-text-3': '#7d8590',
      '--mr-border': '#30363d', '--mr-accent': '#4493f8', '--mr-code-bg': '#161b22',
      '--mr-table-head': '#161b22', '--mr-quote': '#a5b0bb',
      '--mr-paper': '#0e1116', '--mr-paper-grain': grainSvg('0.07'),
    },
  },
  cool: {
    label: '清冷',
    light: {
      '--mr-bg': '#f2f5f9', '--mr-bg-2': '#e7edf4', '--mr-bg-3': '#d9e2ec',
      '--mr-text': '#1f2a38', '--mr-text-2': '#5b6b7f', '--mr-text-3': '#8ca0b5',
      '--mr-border': '#ccd8e4', '--mr-accent': '#2f6fb3', '--mr-code-bg': '#e9eff6',
      '--mr-table-head': '#e7edf4', '--mr-quote': '#5b6b7f',
      '--mr-paper': '#f8fafc', '--mr-paper-grain': 'none',
    },
    dark: {
      '--mr-bg': '#0a0e13', '--mr-bg-2': '#121820', '--mr-bg-3': '#1b242f',
      '--mr-text': '#e6edf3', '--mr-text-2': '#a5b0bb', '--mr-text-3': '#7d8590',
      '--mr-border': '#29323e', '--mr-accent': '#58a6ff', '--mr-code-bg': '#121820',
      '--mr-table-head': '#121820', '--mr-quote': '#a5b0bb',
      '--mr-paper': '#0b0f14', '--mr-paper-grain': 'none',
    },
  },
  eye: {
    label: '护眼',
    light: {
      '--mr-bg': '#e9efe2', '--mr-bg-2': '#dfe8d5', '--mr-bg-3': '#d0dcc2',
      '--mr-text': '#2e3828', '--mr-text-2': '#5c6b4e', '--mr-text-3': '#8a9877',
      '--mr-border': '#c8d3b8', '--mr-accent': '#4a8a4f', '--mr-code-bg': '#e3ead9',
      '--mr-table-head': '#dfe8d5', '--mr-quote': '#5c6b4e',
      '--mr-paper': '#f0f4e7', '--mr-paper-grain': 'none',
    },
    dark: {
      '--mr-bg': '#0d120e', '--mr-bg-2': '#141b15', '--mr-bg-3': '#1d261e',
      '--mr-text': '#e6edf3', '--mr-text-2': '#a5b0bb', '--mr-text-3': '#7d8590',
      '--mr-border': '#2c3a2e', '--mr-accent': '#6fbf73', '--mr-code-bg': '#141b15',
      '--mr-table-head': '#141b15', '--mr-quote': '#a5b0bb',
      '--mr-paper': '#0e140f', '--mr-paper-grain': 'none',
    },
  },
  plain: {
    label: '素白',
    light: {
      '--mr-bg': '#ffffff', '--mr-bg-2': '#f6f8fa', '--mr-bg-3': '#eef1f4',
      '--mr-text': '#1f2328', '--mr-text-2': '#57606a', '--mr-text-3': '#8b949e',
      '--mr-border': '#d0d7de', '--mr-accent': '#0969da', '--mr-code-bg': '#f6f8fa',
      '--mr-table-head': '#f6f8fa', '--mr-quote': '#57606a',
      '--mr-paper': '#ffffff', '--mr-paper-grain': 'none',
    },
    dark: {
      '--mr-bg': '#0d1117', '--mr-bg-2': '#161b22', '--mr-bg-3': '#21262d',
      '--mr-text': '#e6edf3', '--mr-text-2': '#a5b0bb', '--mr-text-3': '#7d8590',
      '--mr-border': '#30363d', '--mr-accent': '#4493f8', '--mr-code-bg': '#161b22',
      '--mr-table-head': '#161b22', '--mr-quote': '#a5b0bb',
      '--mr-paper': '#0d1117', '--mr-paper-grain': 'none',
    },
  },
}

/** Storage key for the global theme preference. */
const THEME_KEY = 'md-reader:theme'
/** The live theme <style> element (set at apply, cleared on dispose). */
let readerThemeEl = null

/** Read the persisted theme id (validated against the registry). */
function currentThemeId() {
  let id = 'warm'
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw !== null && READER_THEMES[raw] !== undefined) id = raw
  } catch { /* persistence unavailable */ }
  return id
}

/** Persist the theme id. */
function writeThemeId(id) {
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch { /* best-effort */ }
}

/** The next theme in cycling order. */
function cycleTheme(id) {
  const ids = Object.keys(READER_THEMES)
  const idx = ids.indexOf(id)
  return ids[(idx + 1) % ids.length] ?? 'warm'
}

/** Build the variable CSS for one theme (light + dark blocks). */
function buildThemeCss(themeId) {
  const theme = READER_THEMES[themeId] ?? READER_THEMES.warm
  const block = (palette) => Object.entries(palette).map(([k, v]) => `${k}: ${v};`).join(' ')
  return `#mr-root { ${block(theme.light)} }\nbody[data-ds-dark-theme] #mr-root { ${block(theme.dark)} }`
}

/** Re-emit the theme variables into the live <style> element. */
function applyReaderTheme(themeId) {
  if (readerThemeEl !== null) readerThemeEl.textContent = buildThemeCss(themeId)
}

/** CSS.escape with a tiny fallback (browsers ship it; guard anyway). */
function cssEscape(value) {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  } catch { /* fall through */ }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}

/** Relative time label for the recent list. */
function recentLabel(at) {
  const delta = Date.now() - at
  if (delta < 60_000) return currentLang === 'zh' ? '刚刚' : 'just now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} h`
  return `${Math.round(delta / 86_400_000)} d`
}

/** Compact local timestamp for the live-file status line. */
function formatFileTime(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return new Intl.DateTimeFormat(currentLang === 'zh' ? 'zh-CN' : 'en', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

/** Copy with a legacy fallback for older embedded Chromium builds. */
async function copyText(text) {
  if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  document.execCommand('copy')
  field.remove()
}

/** Add non-destructive reader controls to sanitized document DOM. */
function decorateReaderDocument(article) {
  if (article === null) return

  for (const pre of Array.from(article.querySelectorAll('pre'))) {
    if (pre.classList.contains('mr-mermaid') || pre.parentElement?.classList.contains('mr-code-wrap')) continue
    const code = pre.querySelector('code')
    if (code === null) continue
    const source = code.textContent ?? ''
    pre.__mrCodeText = source
    const wrapper = document.createElement('div')
    wrapper.className = 'mr-code-wrap'
    pre.before(wrapper)
    wrapper.appendChild(pre)

    const toolbar = document.createElement('div')
    toolbar.className = 'mr-code-toolbar'
    const lang = Array.from(code.classList).find((name) => name.startsWith('language-'))?.slice(9) ?? 'code'
    const label = document.createElement('span')
    label.className = 'mr-code-language'
    label.textContent = lang
    toolbar.appendChild(label)
    for (const spec of [
      ['copy-code', t('copyCode')],
      ['toggle-code', t('collapseCode')],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mr-code-action'
      button.dataset.mrAction = spec[0]
      button.textContent = spec[1]
      if (spec[0] === 'toggle-code') button.setAttribute('aria-expanded', 'true')
      toolbar.appendChild(button)
    }
    wrapper.insertBefore(toolbar, pre)

    const fragment = document.createDocumentFragment()
    const lines = source.replace(/\n$/, '').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = document.createElement('span')
      line.className = 'mr-code-line'
      line.dataset.line = String(i + 1)
      line.textContent = lines[i] === '' ? ' ' : lines[i]
      fragment.appendChild(line)
    }
    code.replaceChildren(fragment)
  }

  for (const table of Array.from(article.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('mr-table-wrap')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'mr-table-wrap'
    table.before(wrapper)
    wrapper.appendChild(table)
  }

  for (const img of Array.from(article.querySelectorAll('img'))) {
    img.tabIndex = 0
    img.title = t('zoomImage')
    img.dataset.mrAction = 'zoom-image'
  }

  const headings = Array.from(article.querySelectorAll('h1, h2, h3, h4'))
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1))
    const nodes = []
    let cursor = heading.nextElementSibling
    while (cursor !== null) {
      if (/^H[1-6]$/.test(cursor.tagName) && Number(cursor.tagName.slice(1)) <= level) break
      nodes.push(cursor)
      cursor = cursor.nextElementSibling
    }
    const chars = nodes.reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0)
    if (chars < LONG_SECTION_CHARS && nodes.length < LONG_SECTION_NODES) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mr-section-toggle'
    button.dataset.mrAction = 'toggle-section'
    button.setAttribute('aria-expanded', 'true')
    button.title = t('collapseSection')
    button.textContent = '−'
    button.__mrSectionNodes = nodes
    heading.appendChild(button)
  }
}

/** Expand any collapsed long section that contains the navigation target. */
function revealReaderElement(article, target) {
  if (article === null || target === null) return
  for (const button of Array.from(article.querySelectorAll('.mr-section-toggle'))) {
    const nodes = button.__mrSectionNodes ?? []
    if (!nodes.some((node) => node === target || node.contains(target))) continue
    for (const node of nodes) node.hidden = false
    button.setAttribute('aria-expanded', 'true')
    button.title = t('collapseSection')
    button.textContent = '−'
  }
}

/**
 * The reader overlay application. Mounted once per page; the overlay stays
 * mounted (display toggled) so scroll position and outline survive closing.
 * Props: onReady(handle) hands the imperative API to the wiring layer.
 */
function ReaderApp({ onReady }) {
  const [open, setOpen] = ReactLib.useState(false)
  const [picker, setPicker] = ReactLib.useState(false)
  const [status, setStatus] = ReactLib.useState('idle') // idle | loading | ready | error
  const [doc, setDoc] = ReactLib.useState(null) // {path,title,html,toc}
  const [error, setError] = ReactLib.useState('')
  const [activeId, setActiveId] = ReactLib.useState(null)
  const [fontSize, setFontSizeState] = ReactLib.useState(FONT_DEFAULT)
  const [outlineOpen, setOutlineOpenState] = ReactLib.useState(true)
  const [autoReload, setAutoReloadState] = ReactLib.useState(false)
  const [externalChange, setExternalChange] = ReactLib.useState(null)
  const [readingProgress, setReadingProgress] = ReactLib.useState(0)
  const [lightbox, setLightbox] = ReactLib.useState(null)
  const [katexTick, setKatexTick] = ReactLib.useState(0)
  const [darkTick, setDarkTick] = ReactLib.useState(0)
  const [recent, setRecent] = ReactLib.useState([])
  const [root, setRootState] = ReactLib.useState('')
  const [themeId, setThemeId] = ReactLib.useState(() => currentThemeId())

  const scrollRef = ReactLib.useRef(null)
  const overlayRef = ReactLib.useRef(null)
  const pathInputRef = ReactLib.useRef(null)
  const pickerInputRef = ReactLib.useRef(null)
  const seqRef = ReactLib.useRef(0)
  const pathRef = ReactLib.useRef('')
  const sourceRef = ReactLib.useRef('')
  const pendingFragmentRef = ReactLib.useRef(null)
  const lastPathRef = ReactLib.useRef('')
  /** Set when a NEW file is opened: the ready effect resets scroll once. */
  const resetScrollRef = ReactLib.useRef(false)
  /** Exact scroll offset restored after an in-place file reload. */
  const restoreScrollRef = ReactLib.useRef(null)
  /** Last content metadata accepted into the rendered document. */
  const fileMetaRef = ReactLib.useRef(null)
  const externalReloadRef = ReactLib.useRef(false)
  /** The KaTeX version the last renderDocument ran with (avoids double renders). */
  const renderedKatexVersionRef = ReactLib.useRef(0)

  // The module-level coreRoot is set by the wiring BEFORE the first render
  // commit, so it is the more reliable source early on; the React state
  // catches up through setRoot. Fall back to the live module value.
  const activeRoot = root !== '' ? root : coreRoot

  const setFontSize = (value) => {
    setFontSizeState(value)
    if (activeRoot !== '') setUi(activeRoot, { fontSize: value })
  }
  const setOutlineOpen = (value) => {
    setOutlineOpenState(value)
    if (activeRoot !== '') setUi(activeRoot, { outlineOpen: value })
  }
  const setAutoReload = (value) => {
    setAutoReloadState(value)
    if (activeRoot !== '') setUi(activeRoot, { autoReload: value })
  }

  /** Open one file (relative to the bound root). */
  const openFile = ReactLib.useCallback(async (path, fragment, options) => {
    if (activeRoot === '') return
    const silent = options?.silent === true
    const preserveScroll = options?.preserveScroll === true
    const oldScroll = preserveScroll && scrollRef.current !== null ? scrollRef.current.scrollTop : null
    const seq = ++seqRef.current
    lastPathRef.current = path
    setOpen(true)
    setPicker(false)
    if (!silent) setStatus('loading')
    setError('')
    const res = await apiRead(activeRoot, path)
    if (seq !== seqRef.current) return
    if (!res.ok) {
      if (silent) {
        const unavailable = res.error?.code === 'not-found' || res.error?.code === 'workspace-unknown'
        setExternalChange({ unavailable, error: res.error, message: `${t('reloadFailed')}: ${mapError(res.error)}` })
        return
      }
      setStatus('error')
      setError(mapError(res.error))
      return
    }
    const rendered = renderDocument(res.value.content, { root: activeRoot, mdPath: path })
    pathRef.current = path
    sourceRef.current = res.value.content
    fileMetaRef.current = { mtime: res.value.mtime, size: res.value.size }
    renderedKatexVersionRef.current = katexVersion
    resetScrollRef.current = !preserveScroll
    restoreScrollRef.current = preserveScroll ? oldScroll : null
    setDoc({
      path,
      title: basename(path),
      html: rendered.html,
      toc: rendered.toc,
      truncated: res.value.truncated === true,
      mtime: res.value.mtime,
      size: res.value.size,
      readingMinutes: estimateReadingMinutes(res.value.content),
    })
    setExternalChange(null)
    setStatus('ready')
    pendingFragmentRef.current = fragment ?? null
    pushRecent(activeRoot, path)
  }, [root])

  /** Reload the current file (or the last attempted one after an error). */
  const reload = ReactLib.useCallback(() => {
    if (status === 'ready' && doc !== null) {
      pendingFragmentRef.current = null
      void openFile(doc.path, undefined, { silent: true, preserveScroll: true })
    } else if (lastPathRef.current !== '') {
      void openFile(lastPathRef.current)
    }
  }, [status, doc, openFile])

  const close = ReactLib.useCallback(() => {
    setOpen(false)
  }, [])

  const showPicker = ReactLib.useCallback(() => {
    setOpen(true)
    setPicker(true)
    setStatus('idle')
    setError('')
    setDoc(null)
    setRecent(getRecent(activeRoot))
  }, [root])

  /** Open the last recent file for the root (or the picker when none). */
  const openLastRecent = ReactLib.useCallback(() => {
    const list = getRecent(activeRoot)
    if (list.length > 0) void openFile(list[0].path)
    else showPicker()
  }, [root, openFile, showPicker])

  const toggle = ReactLib.useCallback(() => {
    if (open) close()
    else openLastRecent()
  }, [open, close, openLastRecent])

  /** Root rebinding: close the overlay when the workspace changes. */
  const setRoot = ReactLib.useCallback((nextRoot) => {
    if (root === nextRoot) return
    if (nextRoot !== '') {
      const ui = getUi(nextRoot)
      setFontSizeState(ui.fontSize)
      setOutlineOpenState(ui.outlineOpen)
      setAutoReloadState(ui.autoReload)
    }
    setRootState(nextRoot)
    seqRef.current += 1
    pathRef.current = ''
    sourceRef.current = ''
    lastPathRef.current = ''
    pendingFragmentRef.current = null
    fileMetaRef.current = null
    restoreScrollRef.current = null
    setOpen(false)
    setPicker(false)
    setStatus('idle')
    setDoc(null)
    setError('')
    setExternalChange(null)
    setReadingProgress(0)
    setLightbox(null)
  }, [root])

  // The imperative API (a stable ref so the wiring layer never needs re-hooks).
  const handleRef = ReactLib.useRef(null)
  handleRef.current = {
    openFile,
    reload,
    close,
    showPicker,
    toggle,
    setRoot,
    openLastRecent,
    onThemeChanged: () => { setDarkTick((v) => v + 1) },
    onKatexReady: () => { setKatexTick((v) => v + 1) },
  }

  // Hand the imperative API to the wiring layer once.
  ReactLib.useEffect(() => {
    onReady(handleRef)
    return () => onReady(null)
  }, [onReady])

  // Focus the overlay shell when it opens (Esc/Tab need focus inside).
  ReactLib.useEffect(() => {
    if (open && overlayRef.current !== null) overlayRef.current.focus()
  }, [open])

  // Lightweight metadata polling keeps the read-only view from silently
  // drifting behind editor/agent writes. Network blips are ignored; a real
  // missing file is surfaced because the currently rendered copy is stale.
  ReactLib.useEffect(() => {
    if (!open || status !== 'ready' || doc === null || activeRoot === '') return undefined
    let stopped = false
    let checking = false
    const check = async () => {
      if (checking || stopped || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
      checking = true
      const res = await apiStat(activeRoot, doc.path)
      checking = false
      if (stopped) return
      if (!res.ok) {
        if (res.error?.code === 'not-found' || res.error?.code === 'workspace-unknown') {
          setExternalChange({ unavailable: true, error: res.error })
        }
        return
      }
      if (!fileMetaChanged(fileMetaRef.current, res.value)) return
      if (autoReload) {
        if (externalReloadRef.current) return
        externalReloadRef.current = true
        try {
          await openFile(doc.path, undefined, { silent: true, preserveScroll: true })
        } finally {
          externalReloadRef.current = false
        }
      } else {
        setExternalChange({ unavailable: false, ...res.value })
      }
    }
    const timer = setInterval(() => { void check() }, CHANGE_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [open, status, doc, root, autoReload, openFile])

  // KaTeX arrived after the document rendered: re-run the pipeline ONCE.
  // NOTE: `doc` is deliberately NOT a dependency — setDoc creates a new doc
  // object, which used to re-trigger this effect endlessly (hundreds of
  // re-renders per second, each resetting scrollTop in the ready effect).
  const hasDocRef = ReactLib.useRef(false)
  hasDocRef.current = doc !== null
  ReactLib.useEffect(() => {
    if (status !== 'ready' || !hasDocRef.current || sourceRef.current === '') return
    if (renderedKatexVersionRef.current === katexVersion) return
    const rendered = renderDocument(sourceRef.current, { root, mdPath: pathRef.current })
    renderedKatexVersionRef.current = katexVersion
    setDoc((prev) => (prev === null ? prev : { ...prev, html: rendered.html, toc: rendered.toc }))
  }, [katexTick, status, root])

  // Document rendered: fragment jump, mermaid, scroll-spy. Scroll position
  // resets ONLY when a new file was opened (resetScrollRef flag), never on
  // re-render passes.
  ReactLib.useEffect(() => {
    if (status !== 'ready' || doc === null) return
    const scroller = scrollRef.current
    if (scroller === null) return
    if (resetScrollRef.current) {
      resetScrollRef.current = false
      scroller.scrollTop = 0
    }
    if (pendingFragmentRef.current !== null) {
      const fragment = pendingFragmentRef.current
      pendingFragmentRef.current = null
      requestAnimationFrame(() => {
        const el = scroller.querySelector(`#${cssEscape(fragment)}`)
        if (el !== null) el.scrollIntoView()
      })
    }
    const article = scroller.querySelector('.mr-doc')
    decorateReaderDocument(article)
    if (restoreScrollRef.current !== null) {
      scroller.scrollTop = restoreScrollRef.current
      restoreScrollRef.current = null
    }
    void renderMermaidIn(scroller, t('mermaidFallback'))

    const heads = Array.from(scroller.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    let raf = 0
    const update = () => {
      raf = 0
      let active = null
      for (const head of heads) {
        if (head.getBoundingClientRect().top <= 90) active = head.id
      }
      setActiveId(active)
      const max = scroller.scrollHeight - scroller.clientHeight
      setReadingProgress(max <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(scroller.scrollTop / max * 100))))
    }
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(update)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    update()

    // Document-level diagnostics (gated; a few lines per page load).
    docDiagCount += 1
    if (docDiagCount <= 3) {
      setTimeout(() => {
        try {
          const docEl = scroller.querySelector('.mr-doc')
          console.log(`[dsh-markdown-reader] 文档诊断 doc #${docDiagCount}:`, {
            path: doc.path,
            scroll: {
              clientHeight: scroller.clientHeight,
              scrollHeight: scroller.scrollHeight,
              overflowY: getComputedStyle(scroller).overflowY,
            },
            docHeight: docEl !== null ? Math.round(docEl.getBoundingClientRect().height) : 0,
            katexSpans: scroller.querySelectorAll('.katex').length,
            pendingMath: scroller.querySelectorAll('.mr-math-pending').length,
            htmlLen: doc.html.length,
          })
        } catch { /* diagnostics never throw */ }
      }, 600)
    }

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [status, doc])

  // Theme change: re-render diagrams.
  ReactLib.useEffect(() => {
    if (darkTick === 0 || status !== 'ready' || doc === null) return
    void refreshMermaid(scrollRef.current, t('mermaidFallback'))
  }, [darkTick, status, doc])

  // Focus the picker input when it opens.
  ReactLib.useEffect(() => {
    if (picker && pickerInputRef.current !== null) pickerInputRef.current.focus()
  }, [picker])

  const scrollToId = (id) => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const el = scroller.querySelector(`#${cssEscape(id)}`)
    if (el !== null) {
      revealReaderElement(scroller.querySelector('.mr-doc'), el)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  /** Click delegation for document controls, images and relative links. */
  const onDocClick = (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const action = target.closest('[data-mr-action]')
    if (action !== null) {
      const kind = action.dataset.mrAction
      if (kind === 'copy-code') {
        event.preventDefault()
        const pre = action.closest('.mr-code-wrap')?.querySelector('pre')
        const text = pre?.__mrCodeText ?? pre?.textContent ?? ''
        void copyText(text).then(() => {
          action.textContent = t('copied')
          setTimeout(() => { if (action.isConnected) action.textContent = t('copyCode') }, 1200)
        }).catch(() => {})
        return
      }
      if (kind === 'toggle-code') {
        event.preventDefault()
        const wrapper = action.closest('.mr-code-wrap')
        if (wrapper === null) return
        const collapsed = wrapper.classList.toggle('mr-code-collapsed')
        action.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
        action.textContent = collapsed ? t('expandCode') : t('collapseCode')
        return
      }
      if (kind === 'toggle-section') {
        event.preventDefault()
        const expanded = action.getAttribute('aria-expanded') === 'true'
        for (const node of action.__mrSectionNodes ?? []) node.hidden = expanded
        action.setAttribute('aria-expanded', expanded ? 'false' : 'true')
        action.title = expanded ? t('expandSection') : t('collapseSection')
        action.textContent = expanded ? '+' : '−'
        return
      }
      if (kind === 'zoom-image' && action.tagName === 'IMG') {
        event.preventDefault()
        setLightbox({ src: action.currentSrc || action.src, alt: action.alt || '' })
        return
      }
    }
    const anchor = target.closest('a')
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    if (href === '' || href.startsWith('#')) return
    if (/^(?:https?:|mailto:)/i.test(href)) return
    event.preventDefault()
    if (isMarkdownPath(href)) {
      const rel = resolveRelativeLink(pathRef.current, href)
      if (rel !== null && rel.path !== null) void openFile(rel.path, rel.fragment ?? undefined)
    }
  }

  const onDocKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target
    if (!(target instanceof Element) || target.dataset.mrAction !== 'zoom-image') return
    event.preventDefault()
    setLightbox({ src: target.currentSrc || target.src, alt: target.alt || '' })
  }

  /** Basic focus trap + Esc inside the overlay. */
  const onOverlayKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (lightbox !== null) {
        setLightbox(null)
        return
      }
      close()
      return
    }
    if (event.key !== 'Tab') return
    const overlay = overlayRef.current
    if (overlay === null) return
    const focusables = Array.from(overlay.querySelectorAll('button, input, a[href]'))
      .filter((el) => el.offsetParent !== null)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const onPickerKeyDown = (event) => {
    if (event.key === 'Enter') {
      const value = (pickerInputRef.current?.value ?? '').trim()
      if (value !== '') void openFile(value)
    }
  }

  const onPickerOpen = (path) => {
    void openFile(path)
  }

  const onPathInputKeyDown = (event) => {
    if (event.key !== 'Enter') return
    const value = (pathInputRef.current?.value ?? '').trim()
    if (value !== '') void openFile(value)
  }

  const adjustFont = (delta) => {
    setFontSize(Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta)))
  }

  /** Cycle to the next reader theme and re-emit its variables. */
  const cycleReaderTheme = () => {
    const next = cycleTheme(themeId)
    setThemeId(next)
    writeThemeId(next)
    applyReaderTheme(next)
  }

  const themeLabel = () => {
    const theme = READER_THEMES[themeId]
    return theme !== undefined ? theme.label : themeId
  }

  const header = h('div', { className: 'mr-header' },
    h('span', { className: 'mr-title' }, doc !== null ? doc.title : t('pickerTitle')),
    doc !== null && h('input', {
      className: 'mr-path',
      ref: pathInputRef,
      key: doc.path,
      defaultValue: doc.path,
      title: t('pathInputTitle'),
      spellCheck: false,
      onKeyDown: onPathInputKeyDown,
    }),
    status === 'ready' && h('span', { className: 'mr-path', style: { flex: 'none', color: 'var(--mr-text-3)' } }, doc.truncated ? `(${t('truncated')})` : ''),
    status === 'ready' && doc !== null && h('span', { className: 'mr-doc-meta' },
      `${doc.readingMinutes} ${t('minute')} · ${t('updatedAt')} ${formatFileTime(doc.mtime)}`,
    ),
    h('span', { style: { flex: 1 } }),
    status === 'ready' && h('label', { className: 'mr-auto-reload', title: t('autoReload') },
      h('input', {
        type: 'checkbox', checked: autoReload,
        onChange: (event) => { setAutoReload(event.target.checked) },
      }),
      t('autoReload'),
    ),
    status === 'ready' && h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('refresh'),
      onClick: () => { reload() },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.refresh } })),
    status === 'ready' && h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('openFile'),
      onClick: () => { showPicker() },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.folder } })),
    status === 'ready' && h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('outline'),
      onClick: () => { setOutlineOpen(!outlineOpen) },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.list } })),
    status === 'ready' && h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('fontSize') + ' −',
      disabled: fontSize <= FONT_MIN,
      onClick: () => { adjustFont(-1) },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.minus } })),
    status === 'ready' && h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('fontSize') + ' +',
      disabled: fontSize >= FONT_MAX,
      onClick: () => { adjustFont(1) },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.plus } })),
    h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: `${t('theme')}：${themeLabel()}`,
      onClick: () => { cycleReaderTheme() },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.palette } })),
    h('button', {
      type: 'button',
      className: 'mr-icon-btn',
      title: t('close'),
      onClick: () => { close() },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.close } })),
  )

  const liveBanner = status === 'ready' && externalChange !== null && h('div', { className: 'mr-live-banner', role: 'status' },
    h('span', { className: 'mr-live-banner-text' },
      externalChange.unavailable
        ? t('fileUnavailable')
        : externalChange.message ?? `${t('fileChanged')}${formatFileTime(externalChange.mtime) !== '' ? ` · ${formatFileTime(externalChange.mtime)}` : ''}`,
    ),
    !externalChange.unavailable && h('button', {
      type: 'button', className: 'mr-btn', onClick: () => { reload() },
    }, t('reloadNow')),
    h('label', { className: 'mr-auto-reload' },
      h('input', {
        type: 'checkbox',
        checked: autoReload,
        onChange: (event) => {
          const enabled = event.target.checked
          setAutoReload(enabled)
          if (enabled && externalChange !== null && !externalChange.unavailable) reload()
        },
      }),
      t('autoReload'),
    ),
  )

  const outline = status === 'ready' && outlineOpen && doc !== null && h('nav', { className: 'mr-outline' },
    h('div', { className: 'mr-outline-title' }, t('outline')),
    doc.toc.length === 0 && h('div', { className: 'mr-outline-empty' }, t('noOutline')),
    doc.toc.map((item) => h('button', {
      type: 'button',
      key: item.id,
      className: `mr-outline-item${item.id === activeId ? ' mr-active' : ''}`,
      style: { paddingLeft: `${10 + (item.level - 1) * 12}px` },
      title: item.label,
      onClick: () => { scrollToId(item.id) },
    }, item.label)),
  )

  const content = (() => {
    if (picker) {
      return h('div', { className: 'mr-picker' },
        h('div', { className: 'mr-picker-card' },
          h('div', { className: 'mr-picker-title' }, t('pickerTitle')),
          h('input', {
            className: 'mr-picker-input',
            ref: pickerInputRef,
            placeholder: t('pickerPlaceholder'),
            spellCheck: false,
            onKeyDown: onPickerKeyDown,
          }),
          recent.length > 0 && h('div', { className: 'mr-picker-recent-title' }, t('recent')),
          recent.length > 0 && h('div', { className: 'mr-picker-recent' },
            recent.map((item) => h('button', {
              type: 'button',
              key: item.path,
              className: 'mr-picker-recent-item',
              onClick: () => { onPickerOpen(item.path) },
            },
              h('span', null, item.path),
              h('span', { className: 'mr-picker-recent-item-time' }, recentLabel(item.at)),
            )),
          ),
          recent.length === 0 && h('div', { className: 'mr-picker-hint' }, t('noRecent')),
          h('div', { className: 'mr-picker-hint' }, t('pickerHint')),
        ),
      )
    }
    if (status === 'loading') {
      return h('div', { className: 'mr-center' },
        h('div', { className: 'mr-spinner' }),
        h('div', null, t('loading')),
      )
    }
    if (status === 'error') {
      return h('div', { className: 'mr-center' },
        h('div', { className: 'mr-error-title' }, t('loadError')),
        h('div', { className: 'mr-error-msg' }, error),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'button', className: 'mr-btn', onClick: () => { reload() } }, t('retry')),
          h('button', { type: 'button', className: 'mr-btn', onClick: () => { showPicker() } }, t('openFile')),
        ),
      )
    }
    if (status === 'ready' && doc !== null) {
      return h('div', { className: 'mr-scroll', ref: scrollRef },
        h('article', {
          className: 'mr-doc',
          style: { fontSize: `${fontSize}px` },
          dangerouslySetInnerHTML: { __html: doc.html },
          onClick: onDocClick,
          onKeyDown: onDocKeyDown,
        }),
      )
    }
    return h('div', { className: 'mr-center' }, h('div', { className: 'mr-error-msg' }, t('noProject')))
  })()

  return h('div', { id: 'mr-root' },
    activeRoot !== '' && !open && h('button', {
      type: 'button',
      className: 'mr-float-btn',
      title: `${t('floatTitle')} (Ctrl+Shift+M)`,
      onClick: () => { openLastRecent() },
    }, h('span', { dangerouslySetInnerHTML: { __html: ICONS.book } })),
    h('div', {
      className: `mr-overlay${open ? '' : ' mr-hidden'}`,
      ref: overlayRef,
      onKeyDown: onOverlayKeyDown,
      tabIndex: -1,
    },
      header,
      status === 'ready' && h('div', { className: 'mr-progress-track', title: `${t('readingTime')} · ${readingProgress}%` },
        h('div', { className: 'mr-progress-bar', style: { width: `${readingProgress}%` } }),
      ),
      liveBanner,
      h('div', { className: 'mr-body' },
        outline,
        content,
      ),
      lightbox !== null && h('div', {
        className: 'mr-lightbox',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('zoomImage'),
        onClick: (event) => { if (event.target === event.currentTarget) setLightbox(null) },
      },
        h('img', { src: lightbox.src, alt: lightbox.alt }),
        h('div', { className: 'mr-lightbox-actions' },
          h('a', { className: 'mr-btn', href: lightbox.src, download: '' }, t('downloadImage')),
          h('button', { type: 'button', className: 'mr-btn', onClick: () => { setLightbox(null) } }, t('close')),
        ),
      ),
    ),
  )
}

// #endregion

// #region ===== 11. entry wiring =====

/** Module-level core state shared between the wiring layer and the UI handle. */
let coreRoot = ''
/** The reader app's stable handle ref ({current: handle}). */
let handleRef = null
let panelTrack = { root: '', path: '', at: 0 }
/** How many document-diagnostics lines have been logged this page load. */
let docDiagCount = 0
/** Apply generation counter: stale applies become no-ops on dispose. */
let applyGeneration = 0

/** Dereference the current UI handle (null when unmounted). */
const H = () => (handleRef !== null ? handleRef.current : null)

/**
 * Read-only snapshot of the reader's browser-side state (used by the built-in
 * diagnostics log and window.dshMarkdownReader.diagnose()). Never mutates
 * anything.
 */
function readDiagnostics() {
  const out = {}
  const style = document.getElementById('dsh-markdown-reader-style')
  out.styleInjected = style !== null
  out.styleLen = style !== null ? style.textContent.length : 0
  const ov = document.querySelector('.mr-overlay')
  out.overlayMounted = ov !== null
  if (ov !== null) {
    const c = getComputedStyle(ov)
    out.overlay = { position: c.position, overflow: c.overflow, height: c.height, display: c.display, zIndex: c.zIndex }
  }
  const sc = document.querySelector('.mr-scroll')
  if (sc !== null) {
    const c = getComputedStyle(sc)
    out.scroll = {
      clientHeight: sc.clientHeight,
      scrollHeight: sc.scrollHeight,
      overflowY: c.overflowY,
      height: c.height,
      position: c.position,
    }
  } else {
    out.scroll = null
  }
  const docEl = document.querySelector('.mr-doc')
  out.docHeight = docEl !== null ? Math.round(docEl.getBoundingClientRect().height) : 0
  const katexCss = document.querySelector('link[href*="katex.min.css"]')
  out.katexCssLink = katexCss !== null
  if (katexCss !== null) {
    try {
      out.katexCssRules = katexCss.sheet !== null ? katexCss.sheet.cssRules.length : -1
    } catch (err) {
      out.katexCssRules = `ERR:${String(err && err.message)}`
    }
  }
  out.katexLoaded = typeof globalThis.katex === 'object' && globalThis.katex !== null
  out.floatBtn = document.querySelector('.mr-float-btn') !== null
  out.panelBtn = document.querySelector('.mr-read-btn') !== null
  out.pendingMath = document.querySelectorAll('.mr-math-pending').length
  out.katexSpans = document.querySelectorAll('.mr-doc .katex').length
  out.mathDisplayBlocks = document.querySelectorAll('.mr-math-display').length
  out.mermaidSvg = document.querySelectorAll('.mr-mermaid-render svg').length
  out.mermaidFallback = document.querySelectorAll('pre.mr-mermaid-fallback').length
  out.root = coreRoot
  return out
}

/** Open a file in the reader (public entry, used by all entry points). */
function openReaderPath(path, fragment) {
  const current = H()
  if (current === null) return
  if (typeof path !== 'string' || path === '') {
    current.showPicker()
    return
  }
  void current.openFile(path.replace(/\\/g, '/'), fragment ?? undefined)
}

/** Track the last markdown file the user clicked inside the aionui panel. */
function installPanelTracking(alive) {
  const guard = alive ?? (() => true)
  const onClick = (event) => {
    if (!guard()) return
    const target = event.target
    if (!(target instanceof Element)) return
    const titled = target.closest('[title]')
    if (titled === null) return
    const column = titled.closest('[data-aionui-preview-col], [data-aionui-explorer-col]')
    if (column === null) return
    // Skip clicks on inner action buttons (close glyphs etc.).
    const innerBtn = target.closest('[role="button"]')
    if (innerBtn !== null && innerBtn !== titled && innerBtn.getAttribute('aria-label') !== null) return
    const title = titled.getAttribute('title') ?? ''
    if (!isMarkdownPath(title)) return
    panelTrack = { root: coreRoot, path: title.replace(/\\/g, '/'), at: Date.now() }
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}

/** Append the「阅读模式」button into the panel's preview toolbar (structural slot). */
function ensurePanelButton(alive) {
  const guard = alive ?? (() => true)
  if (!guard()) return
  const panelRoot = document.querySelector('[data-aionui-preview-col] .aionui-root')
  if (panelRoot === null) return
  const toolbar = panelRoot.children[1]
  if (toolbar === undefined || toolbar.querySelector('button') === null) return
  let btn = toolbar.querySelector('.mr-read-btn')
  if (btn === null) {
    btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mr-read-btn'
    btn.title = t('panelBtnTitle')
    btn.innerHTML = `${ICONS.book}<span>${t('panelBtn')}</span>`
  }
  btn.__mrAlive = guard
  btn.onclick = (event) => {
    event.stopPropagation()
    if (!guard()) return
    if (panelTrack.root === coreRoot && panelTrack.path !== '' && panelTrack.at > 0) {
      openReaderPath(panelTrack.path)
    } else {
      const current = H()
      if (current !== null) current.showPicker()
    }
  }
  if (btn.parentElement !== toolbar || btn !== toolbar.lastElementChild) {
    toolbar.appendChild(btn)
  }
}

/** Watch the panel DOM for the toolbar slot (re-append after React re-renders). */
function installPanelButtonObserver(alive) {
  const observer = new MutationObserver(() => { ensurePanelButton(alive) })
  observer.observe(document.body, { childList: true, subtree: true })
  ensurePanelButton(alive)
  return () => {
    observer.disconnect()
    const btn = document.querySelector('.mr-read-btn')
    if (btn !== null && btn.__mrAlive === alive) btn.remove()
  }
}

/** Global shortcut: Ctrl/Cmd+Shift+M toggles the reader. */
function onGlobalKeyDown(event) {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
  if (event.key !== 'M' && event.key !== 'm') return
  event.preventDefault()
  const current = H()
  if (current !== null) current.toggle()
}

/** External integrations: CustomEvent + window API. */
function onOpenEvent(event) {
  const detail = (event && event.detail) || {}
  const path = typeof detail.path === 'string' ? detail.path : null
  const fragment = typeof detail.fragment === 'string' ? detail.fragment : undefined
  if (path !== null) openReaderPath(path, fragment)
  else {
    const current = H()
    if (current !== null) current.showPicker()
  }
}

/** Observe the shell's dark-mode marker for mermaid theme re-renders. */
function installThemeObserver(alive) {
  const guard = alive ?? (() => true)
  let last = themeIsDark()
  const observer = new MutationObserver(() => {
    if (!guard()) return
    const now = themeIsDark()
    if (now === last) return
    last = now
    const current = H()
    if (current !== null) current.onThemeChanged()
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => { observer.disconnect() }
}

/** The dual-face plugin exports the client runner consumes. */
const api = {
  inject: ['sessions'],
  apply(ctx) {
    // The loader hands us the module-table require through the factory; react
    // comes from the shell's shared modules. ReactLib is module-scope so the
    // UI section (ReaderApp/h) can reach it.
    if (api.__require === undefined) throw new Error('dsh-markdown-reader: module require unavailable')
    ReactLib = api.__require('react')
    const { createRoot } = api.__require('react-dom/client')

    // Generation isolation: skin switches / HMR re-apply this plugin while
    // the previous wiring may still be torn down. Every callback and every
    // disposer is generation-guarded so a STALE apply can never remove the
    // newer apply's styles, listeners, or handle (the bug where switching
    // the GUI skin killed the floating button and the reader).
    const generation = ++applyGeneration
    console.log(`[dsh-markdown-reader] 生命周期 apply #${generation} start`)

    ctx.effect(() => {
      detectLang()
      let root = null
      let hostElement = null
      const disposers = []
      const alive = () => generation === applyGeneration
      try {
        // Stylesheet (removed on dispose; stale elements are claimed first).
        const previous = document.getElementById('dsh-markdown-reader-style')
        if (previous !== null) previous.remove()
        const style = document.createElement('style')
        style.id = 'dsh-markdown-reader-style'
        style.textContent = READER_CSS
        document.head.appendChild(style)
        disposers.push(() => { style.remove() })

        // Theme variables (persisted theme; overrides the warm-paper defaults).
        const prevTheme = document.getElementById('dsh-markdown-reader-theme')
        if (prevTheme !== null) prevTheme.remove()
        const themeStyle = document.createElement('style')
        themeStyle.id = 'dsh-markdown-reader-theme'
        themeStyle.textContent = buildThemeCss(currentThemeId())
        document.head.appendChild(themeStyle)
        readerThemeEl = themeStyle
        disposers.push(() => { themeStyle.remove() })

        // Reader overlay root (stale mounts from a crashed apply are claimed).
        for (const staleMount of Array.from(document.querySelectorAll('#mr-mount'))) {
          try { staleMount.remove() } catch { /* no-op */ }
        }
        hostElement = document.createElement('div')
        hostElement.id = 'mr-mount'
        document.body.appendChild(hostElement)
        root = createRoot(hostElement)
        root.render(ReactLib.createElement(ReaderApp, {
          onReady: (ref) => { if (alive()) handleRef = ref },
        }))

        // Self-healing watchdogs: a skin switch / in-place UI rebuild can
        // detach the mount or the style tags from the DOM even when this
        // wiring is still the live generation. Re-attach them and log the
        // stack so the exact culprit is visible in the console.
        const mountWatch = new MutationObserver(() => {
          if (!alive() || hostElement === null) return
          if (hostElement.isConnected === false) {
            console.warn('[dsh-markdown-reader] 生命周期 #mr-mount detached from the DOM — re-attaching', new Error().stack)
            document.body.appendChild(hostElement)
          }
        })
        mountWatch.observe(document.body, { childList: true })
        disposers.push(() => { mountWatch.disconnect() })

        const headWatch = new MutationObserver(() => {
          if (!alive()) return
          if (style.isConnected === false) {
            console.warn('[dsh-markdown-reader] 生命周期 stylesheet removed from <head> — re-adding', new Error().stack)
            document.head.appendChild(style)
          }
          if (themeStyle.isConnected === false) {
            console.warn('[dsh-markdown-reader] 生命周期 theme sheet removed from <head> — re-adding', new Error().stack)
            document.head.appendChild(themeStyle)
          }
        })
        headWatch.observe(document.head, { childList: true })
        disposers.push(() => { headWatch.disconnect() })

        console.log(`[dsh-markdown-reader] 生命周期 apply #${generation} wired (mount + styles + watchdogs)`)

        // KaTeX arrived → re-render the open document through the UI.
        const onKatexReady = () => {
          if (!alive()) return
          const current = H()
          if (current !== null) current.onKatexReady()
        }
        katexReadyListeners.add(onKatexReady)
        disposers.push(() => { katexReadyListeners.delete(onKatexReady) })

        // Project root follows the active session's cwd.
        const bindRoot = () => {
          if (!alive()) return
          let next = ''
          try {
            const snapshot = ctx.sessions.list.getSnapshot()
            const sessionId = snapshot.current
            const cwd = sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd
            next = typeof cwd === 'string' && cwd !== '' ? cwd : ''
          } catch { /* sessions unavailable: no root */ }
          if (next === coreRoot && H() !== null) return
          coreRoot = next
          panelTrack = { root: '', path: '', at: 0 }
          const current = H()
          if (current !== null) {
            current.setRoot(next)
            return
          }
          // The UI handle is not mounted yet (bindRoot can run before the
          // first React commit delivers onReady). Retry until it arrives; the
          // sessions subscription would also re-fire on the next update.
          let attempts = 0
          const retry = () => {
            if (!alive() || attempts >= 30) return
            attempts += 1
            const latest = H()
            if (latest === null) {
              setTimeout(retry, attempts <= 3 ? 0 : 100)
              return
            }
            latest.setRoot(next)
          }
          retry()
        }
        disposers.push(ctx.sessions.list.subscribe(bindRoot))
        bindRoot()

        // Language mirroring (the shell owns <html lang>).
        let langObserver = null
        const syncLanguage = () => { if (alive()) detectLang() }
        langObserver = new MutationObserver(syncLanguage)
        langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        disposers.push(() => { langObserver.disconnect() })

        // Entry points (generation-guarded so a stale listener is a no-op
        // instead of double-toggling).
        const onKey = (event) => { if (alive()) onGlobalKeyDown(event) }
        const onOpen = (event) => { if (alive()) onOpenEvent(event) }
        window.addEventListener('keydown', onKey)
        disposers.push(() => { window.removeEventListener('keydown', onKey) })
        document.addEventListener('dsh-markdown-reader:open', onOpen)
        disposers.push(() => { document.removeEventListener('dsh-markdown-reader:open', onOpen) })
        disposers.push(installPanelTracking(alive))
        disposers.push(installPanelButtonObserver(alive))
        disposers.push(installThemeObserver(alive))
        try {
          window.dshMarkdownReader = {
            __mrGen: generation,
            open: (path, fragment) => openReaderPath(path, fragment),
            toggle: () => { const current = H(); if (current !== null) current.toggle() },
            close: () => { const current = H(); if (current !== null) current.close() },
            pick: () => { const current = H(); if (current !== null) current.showPicker() },
            diagnose: () => readDiagnostics(),
          }
        } catch { /* window API optional */ }

        // Built-in diagnostics: logged once shortly after wiring so the user
        // can report the reader's browser-side state without pasting anything
        // into the DevTools console.
        const diagTimer = setTimeout(() => {
          try {
            if (alive()) console.log('[dsh-markdown-reader] 接线诊断 wiring:', readDiagnostics())
          } catch { /* diagnostics never throw */ }
        }, 1200)
        disposers.push(() => { clearTimeout(diagTimer) })

        return () => {
          // A superseded apply's cleanup must not touch the newer one's state.
          console.log(`[dsh-markdown-reader] 生命周期 dispose #${generation} called (${alive() ? 'live' : 'stale → isolated cleanup'}, current gen ${applyGeneration})`)
          const wasLive = alive()
          try {
            if (wasLive && window.dshMarkdownReader !== null && typeof window.dshMarkdownReader === 'object' && window.dshMarkdownReader.__mrGen === generation) {
              delete window.dshMarkdownReader
            }
          } catch { /* no-op */ }
          for (const dispose of disposers) {
            try { dispose() } catch { /* no-op */ }
          }
          if (root !== null) {
            try { root.unmount() } catch { /* no-op */ }
          }
          if (hostElement !== null) {
            try { hostElement.remove() } catch { /* no-op */ }
          }
          if (wasLive && readerThemeEl === themeStyle) readerThemeEl = null
          if (wasLive) handleRef = null
        }
      } catch (error) {
        // A wiring failure degrades the reader, never the GUI boot.
        console.error('[dsh-markdown-reader] wiring failed:', error)
        for (const dispose of disposers) {
          try { dispose() } catch { /* no-op */ }
        }
        if (root !== null) {
          try { root.unmount() } catch { /* no-op */ }
        }
        if (hostElement !== null) {
          try { hostElement.remove() } catch { /* no-op */ }
        }
        if (readerThemeEl === themeStyle) readerThemeEl = null
        handleRef = null
        return () => {}
      }
    }, 'dsh-markdown-reader: wiring')
  },
}

// #endregion

// #region ===== 12. loader registration + Node test exports =====

if (typeof window !== 'undefined' && typeof window.__ModuleLoader__ === 'object' && window.__ModuleLoader__ !== null) {
  // Defensive registration: an in-place re-boot (skin switch re-fetches the
  // boot graph) can re-execute this bundle script while the loader still
  // holds the previous factory. The loader then throws "duplicate factory
  // registration" — swallowed here so the re-execution never kills the
  // script (the previous factory stays registered and keeps working).
  try {
    window.__ModuleLoader__.load({
      id: PKG_ID,
      factory: (require) => {
        api.__require = require
        return api
      },
    })
    console.log('[dsh-markdown-reader] 生命周期 registered with the module loader')
  } catch (error) {
    console.warn('[dsh-markdown-reader] 生命周期 duplicate registration skipped (in-place re-execution):', error && error.message)
  }
}

if (typeof module !== 'undefined' && module.exports) {
  // Node (tests): expose the pure engine.
  module.exports = {
    escapeHtml,
    protectMath,
    parseBlocks,
    renderInline,
    renderDocument,
    sanitizeHtml,
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
    apiRead,
    apiStat,
    fileMetaChanged,
    estimateReadingMinutes,
    renderKatex,
    restoreMath,
    PH_RE,
    ID_RE,
    READER_THEMES,
    buildThemeCss,
    cycleTheme,
  }
}
