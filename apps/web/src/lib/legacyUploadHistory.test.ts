import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultDefinition, type QuestionRecord } from './prdApi'
import { formatLegacyUploadSize, legacyUploadScope, normalizeLegacyUploads } from './legacyUploadHistory'

const question = (): QuestionRecord => ({
  id: 'CHATOPS-AD-ATK',
  title: 'ChatOps',
  category: 'adversarial',
  difficulty: 'L2',
  revision: 2,
  definition: { ...defaultDefinition(), scenarioId: 'chatops', role: 'attack' },
})

test('history requests map the fixed role and never use client-supplied user or work directory selectors', () => {
  const q = question()
  assert.deepEqual(legacyUploadScope(q), {
    scenario: 'chatops',
    role: 'solo_attack',
    query: '/matches/uploads?scenario=chatops&role=solo_attack',
  })
  q.role = 'defense'
  assert.equal(legacyUploadScope(q)?.query, '/matches/uploads?scenario=chatops&role=solo_defense')
  q.definition.scenarioId = 'unrelated-new-course'
  assert.equal(legacyUploadScope(q), null)
  assert.equal(legacyUploadScope({ ...question(), category: 'basic' }), null)
  const missingRole = question()
  missingRole.definition.role = undefined
  assert.equal(legacyUploadScope(missingRole), null)
})

test('legacy uploads retain only display data for the selected scenario and role', () => {
  const scope = legacyUploadScope(question())!
  const base = {
    scenario: 'chatops',
    role: 'solo_attack',
    fileName: 'exercise.zip',
    size: 2048,
    version: 2,
    uploadedAt: '2026-10-09T09:00:00Z',
    archived: true,
  }
  const result = normalizeLegacyUploads(
    [
      {
        ...base,
        workDir: '/srv/secret/student',
        workDirId: 'internal-id',
        githubAccount: 'private-account',
        userId: 'owner',
      },
      { ...base, scenario: 'webbot' },
      { ...base, role: 'solo_defense' },
      { ...base, fileName: 'older.zip', uploadedAt: '2026-10-08T09:00:00Z' },
      null,
    ],
    scope,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[0], {
    fileName: 'exercise.zip',
    size: 2048,
    version: 2,
    uploadedAt: '2026-10-09T09:00:00.000Z',
    archived: true,
  })
  assert.doesNotMatch(JSON.stringify(result), /secret|internal-id|private-account|owner|workDir|userId/)
})

test('bad legacy fields do not reveal paths, manufacture archive status or become a fresh upload', () => {
  const scope = legacyUploadScope(question())!
  const result = normalizeLegacyUploads(
    [
      {
        scenario: 'chatops',
        role: 'solo_attack',
        fileName: 'C:\\private\\student\\answer.zip',
        size: -3,
        version: 0,
        uploadedAt: 'not-a-date',
        archived: 'true',
      },
      {
        scenario: 'chatops',
        role: 'solo_attack',
        fileName: '/srv/private/second.zip',
        size: 0,
        version: 1,
        archived: false,
      },
    ],
    scope,
  )
  assert.deepEqual(result[0], {
    fileName: 'answer.zip',
    size: null,
    version: null,
    uploadedAt: null,
    archived: null,
  })
  assert.equal(result[1].fileName, 'second.zip')
  assert.equal(result[1].size, 0)
  assert.equal(result[1].archived, false)
  assert.throws(() => normalizeLegacyUploads({ message: 'wrong shape' }, scope), /格式异常/)
  assert.deepEqual(normalizeLegacyUploads([], scope), [])
})

test('legacy file sizes distinguish missing metadata from an empty file', () => {
  assert.equal(formatLegacyUploadSize(null), '未记录')
  assert.equal(formatLegacyUploadSize(0), '0 B')
  assert.equal(formatLegacyUploadSize(2048), '2.0 KB')
  assert.equal(formatLegacyUploadSize(1024 * 1024), '1.0 MB')
})
