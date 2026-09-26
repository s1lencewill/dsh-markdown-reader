/**
 * DSH 0.1.7-rc.2 adaptation regressions:
 *   - the client workspace-root resolver must accept BOTH session-list shapes
 *     (older `{current, byId}` and newer `{ids, byId, phase}` with
 *     `retainedBy.mainView`);
 *   - the package manifest must not reference the retired client-runtime
 *     module id, and must declare the current session service provider.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const engine = require('../lib/client.cjs')
const packageJson = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))

const { pickWorkspaceRoot } = engine

test('pickWorkspaceRoot reads the older {current, byId} shape', () => {
  const snapshot = {
    current: 'session-b',
    byId: {
      'session-a': { id: 'session-a', cwd: 'C:/work/a' },
      'session-b': { id: 'session-b', cwd: 'C:/work/b' },
    },
  }
  assert.equal(pickWorkspaceRoot(snapshot), 'C:/work/b')
})

test('pickWorkspaceRoot reads the 0.1.7-rc.2 {ids, byId, phase} shape', () => {
  const snapshot = {
    ids: ['s1', 's2'],
    phase: 'ready',
    projectionsBySession: {},
    byId: {
      s1: { id: 's1', cwd: 'C:/old', retainedBy: {}, updatedAt: 100 },
      s2: { id: 's2', cwd: 'G:/hanako/dsh_plu', retainedBy: { mainView: 1 }, updatedAt: 50 },
    },
  }
  assert.equal(pickWorkspaceRoot(snapshot), 'G:/hanako/dsh_plu')
})

test('pickWorkspaceRoot never invents a root and tolerates odd input', () => {
  assert.equal(pickWorkspaceRoot(null), '')
  assert.equal(pickWorkspaceRoot({}), '')
  assert.equal(pickWorkspaceRoot({ byId: null }), '')
  // Newer shape, no main-view retention yet: newest session with a cwd wins.
  assert.equal(
    pickWorkspaceRoot({
      ids: ['s1', 's2'],
      byId: {
        s1: { id: 's1', cwd: 'C:/older', retainedBy: {}, updatedAt: 10 },
        s2: { id: 's2', cwd: 'C:/newer', retainedBy: {}, updatedAt: 20 },
      },
    }),
    'C:/newer',
  )
  // Rows without a cwd (e.g. subagent projections) are ignored.
  assert.equal(pickWorkspaceRoot({ ids: ['x'], byId: { x: { id: 'x', origin: 'subagent' } } }), '')
})

test('client manifest targets the current session service provider', () => {
  const inject = packageJson.dsh?.client?.inject
  assert.deepEqual(inject, ['@deepseek-ai/dsh-api-session-controller'])
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-runtime'), 'the retired client runtime must not be an inject edge')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.equal(packageJson.dsh.engines.dsh, '>=0.1.7-rc.2')
})

test('package metadata carries no retired DSH peer dependencies', () => {
  const peers = Object.keys(packageJson.peerDependencies ?? {})
  assert.deepEqual(peers, ['react'])
  const manifestText = JSON.stringify(packageJson)
  assert.ok(!manifestText.includes('0.1.0-rc.6'), 'stale 0.1.0-rc.6 peer ranges must be gone')
})
