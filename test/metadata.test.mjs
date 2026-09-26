import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))

test('package scope is consistent across host, client, patch, and docs', async () => {
  const expected = '@s1lencewill/dsh-markdown-reader'
  assert.equal(packageJson.name, expected)
  for (const relative of ['cordis.patch.yml', 'lib/index.js', 'lib/client.cjs', 'README.md']) {
    const text = await readFile(`${root}/${relative}`, 'utf8')
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(text, /@linxin666\/dsh-markdown-reader/)
  }
})

test('declared license file is present', async () => {
  assert.equal(packageJson.license, 'BSD-3-Clause')
  const license = await readFile(`${root}/LICENSE`, 'utf8')
  assert.match(license, /^BSD 3-Clause License/)
})

test('npm repository metadata points at the public repository', () => {
  assert.equal(packageJson.repository?.url, 'git+https://github.com/s1lencewill/dsh-markdown-reader.git')
  assert.equal(packageJson.homepage, 'https://github.com/s1lencewill/dsh-markdown-reader#readme')
  assert.equal(packageJson.bugs?.url, 'https://github.com/s1lencewill/dsh-markdown-reader/issues')
})

test('README documents the client bundle contract for the current delivery scheme', async () => {
  const readme = await readFile(`${root}/README.md`, 'utf8')
  const readmeEn = await readFile(`${root}/README_EN.md`, 'utf8')
  for (const text of [readme, readmeEn]) {
    assert.match(text, /__ModuleLoader__\.load/)
    // 0.1.7-rc.2 delivers client bundles in batches; the docs must say so.
    assert.match(text, /batch|批量/)
  }
  // The retired single-entry route and the retired package scope stay out.
  assert.doesNotMatch(readme, /\/plugins\/ui-dsh-markdown-reader\/client\.js/)
  assert.doesNotMatch(readme, /@linxin666\/dsh-markdown-reader/)
})
