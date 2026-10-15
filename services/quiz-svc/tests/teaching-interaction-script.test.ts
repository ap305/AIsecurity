import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_ACCEPTANCE_IDS } from '../scripts/acceptanceLegacyCourses.js'
import {
  assertSafeTeachingDiagnostics,
  main,
  verifyTeachingInteraction,
} from '../scripts/verifyTeachingInteraction.js'

const diagnostics = () => ({
  questionVersion: 2,
  evaluationVersion: 'course-v2',
  historicalVersion: false,
  phase: 'opponents',
  state: 'completed',
  metrics: {},
  baseline: { metric: 'qualificationMetric', value: 0.5, threshold: 0.5, comparator: '>=', passed: true },
  evaluation: {
    state: 'completed',
    snapshotRevision: 1,
    counted: true,
    successCount: 0,
    opponentCount: 0,
    emptyPool: true,
    pairs: [],
  },
  progress: null,
})
async function fixture(options: { noSubmissions?: boolean; allowForeign?: boolean } = {}) {
  const methods: string[] = []
  const tokens = [
    'private-token-admin-sentinel',
    'private-token-student-a-sentinel',
    'private-token-student-b-sentinel',
  ]
  const users = ['PRIVATE_ADMIN_ID', 'PRIVATE_STUDENT_A_ID', 'PRIVATE_STUDENT_B_ID']
  const hasHistory = (actor: number, questionId: string) =>
    actor > 0 && !options.noSubmissions && questionId === LEGACY_ACCEPTANCE_IDS[0]
  const history = (actor: number, questionId: string) =>
    hasHistory(actor, questionId)
      ? [
          {
            id: `PRIVATE_SUBMISSION_${actor}`,
            userId: users[actor],
            questionId,
            questionVersion: 2,
            code: 'PRIVATE_STUDENT_SOURCE',
            category: 'adversarial',
            role: 'attack',
            status: 'completed',
            score: 100,
            diagnostics: diagnostics(),
          },
        ]
      : []
  const server = http
    .createServer((req, res) => {
      methods.push(req.method || '')
      const actor = tokens.indexOf((req.headers.authorization || '').replace('Bearer ', ''))
      const url = new URL(req.url || '', 'http://localhost')
      const route = url.pathname.slice('/api'.length)
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ code: status === 200 ? 0 : status, data, message: 'PRIVATE_RESPONSE_MESSAGE' }),
        )
      }
      if (req.method !== 'GET') return send(null, 405)
      if (actor < 0) return send(null, 401)
      if (route === '/auth/me')
        return send({
          user: {
            id: users[actor],
            username: 'PRIVATE_USERNAME',
            displayName: 'PRIVATE_DISPLAY_NAME',
            role: actor === 0 ? 'admin' : 'student',
          },
        })
      if (route === '/questions')
        return send(
          LEGACY_ACCEPTANCE_IDS.map((id, index) => ({
            id,
            status: 'published',
            category: 'adversarial',
            scenarioId: `scene-${Math.floor(index / 2)}`,
            role: index % 2 ? 'defense' : 'attack',
            revision: 2,
            evaluationVersion: 'course-v2',
            attempted: hasHistory(actor, id),
            hasHistoricalAttempts: false,
            latestSubmissionStatus: hasHistory(actor, id) ? 'completed' : null,
            myStatus: hasHistory(actor, id) ? 'completed' : 'not_submitted',
            myScore: hasHistory(actor, id) ? 100 : null,
            tags: ['LLM 安全'],
            dynamicScore: { updatedAt: null },
            definition: { evaluation: { baselineThreshold: 0.5, successThreshold: 0.5 } },
          })),
        )
      const resource = route.match(/^\/questions\/([^/]+)\/resources$/)
      if (resource) return send([{ filename: 'template.py', size: 20 }])
      const score = route.match(/^\/arena\/questions\/([^/]+)\/score$/)
      if (score) {
        const index = LEGACY_ACCEPTANCE_IDS.indexOf(score[1] as any)
        const counted = hasHistory(actor, score[1])
        return send({
          questionId: score[1],
          questionVersion: 2,
          role: index % 2 ? 'defense' : 'attack',
          score: counted ? 100 : null,
          counted,
          qualified: counted,
          successCount: counted ? 0 : null,
          opponentCount: counted ? 0 : null,
          updatedAt: null,
        })
      }
      const ownHistory = route.match(/^\/questions\/([^/]+)\/submissions$/)
      if (ownHistory) return send(history(actor, ownHistory[1]))
      const submission = route.match(/^\/submissions\/PRIVATE_SUBMISSION_(\d)$/)
      if (submission) {
        const owner = Number(submission[1])
        if (owner !== actor && actor !== 0 && !options.allowForeign) return send(null, 404)
        return send(history(owner, LEGACY_ACCEPTANCE_IDS[0])[0])
      }
      if (/^\/users\/[^/]+\/stats$/.test(route))
        return send({ displayName: 'PRIVATE_DISPLAY_NAME', totalScore: 0, tasksCompleted: 0 })
      if (route.startsWith('/admin/student-scores') && actor !== 0) return send(null, 403)
      if (route === '/admin/student-scores')
        return send({
          total: 2,
          students: users
            .slice(1)
            .map((userId) => ({
              userId,
              username: 'PRIVATE_USERNAME',
              submittedQuestionCount: options.noSubmissions ? 0 : 1,
            })),
        })
      const detail = route.match(/^\/admin\/student-scores\/([^/]+)$/)
      if (detail) {
        const index = users.indexOf(detail[1])
        return send({
          student: { userId: detail[1], username: 'PRIVATE_USERNAME' },
          questions: options.noSubmissions
            ? []
            : [
                {
                  questionId: LEGACY_ACCEPTANCE_IDS[0],
                  score: 100,
                  category: 'adversarial',
                  scoreKind: 'current',
                  submissionCount: 1,
                  latestSubmission: { id: `PRIVATE_SUBMISSION_${index}` },
                },
              ],
        })
      }
      return send(null, 404)
    })
    .listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    tokens,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('diagnostic validation rejects extra nested materials and non-inclusive decisions', () => {
  assert.doesNotThrow(() => assertSafeTeachingDiagnostics(diagnostics()))
  const leaked = diagnostics() as any
  leaked.evaluation.pairs = [
    {
      ordinal: 1,
      state: 'completed',
      success: true,
      metric: 'successMetric',
      value: 1,
      threshold: 0.5,
      opponentCode: 'PRIVATE_SOURCE',
    },
  ]
  assert.throws(() => assertSafeTeachingDiagnostics(leaked), /unapproved_fields/)
  const wrong = diagnostics()
  wrong.baseline.passed = false
  assert.throws(() => assertSafeTeachingDiagnostics(wrong), /baseline_decision_inconsistent/)
  const hiddenMetric = diagnostics() as any
  hiddenMetric.metrics.hiddenAnswer = 42
  assert.throws(() => assertSafeTeachingDiagnostics(hiddenMetric), /metrics_not_allowlisted/)
})

test('verifier uses only GET, exercises existing ownership boundaries and emits no identities, source or tokens', async () => {
  const f = await fixture()
  try {
    const report = await verifyTeachingInteraction(f)
    assert.equal(
      report.status,
      'passed',
      JSON.stringify(report.checks.filter((check) => check.status !== 'passed')),
    )
    assert.equal(report.summary.failed, 0)
    assert.equal(report.summary.notExercised, 0)
    assert.ok(f.methods.length > 60)
    assert.ok(f.methods.every((method) => method === 'GET'))
    assert.doesNotMatch(
      JSON.stringify(report),
      /PRIVATE_|private-token-|username|displayName|studentId|userId|submissionId|OWN_CODE/,
    )
  } finally {
    await f.close()
  }
})

test('administrator-only access cannot be mislabeled as student privacy or diagnostic acceptance', async () => {
  const f = await fixture()
  try {
    const report = await verifyTeachingInteraction({ api: f.api, tokens: [f.tokens[0]] })
    assert.equal(report.status, 'partial')
    assert.equal(report.summary.failed, 0)
    assert.ok(
      report.checks.some(
        (check) => check.status === 'not-exercised' && check.reason === 'student_token_not_supplied',
      ),
    )
  } finally {
    await f.close()
  }
})

test('empty real histories report diagnostics and cross-user access as not-exercised', async () => {
  const f = await fixture({ noSubmissions: true })
  try {
    const report = await verifyTeachingInteraction(f)
    assert.equal(report.status, 'partial')
    assert.equal(report.summary.failed, 0)
    assert.equal(report.checks.filter((check) => check.reason === 'no_existing_submissions').length, 2)
    assert.ok(report.checks.some((check) => check.reason === 'no_existing_foreign_submission_available'))
  } finally {
    await f.close()
  }
})

test('a cross-user leak fails acceptance without persisting the returned private payload', async () => {
  const f = await fixture({ allowForeign: true })
  try {
    const report = await verifyTeachingInteraction(f)
    assert.equal(report.status, 'failed')
    assert.ok(
      report.checks.some(
        (check) =>
          check.name === 'foreign existing submissions are inaccessible to a student' &&
          check.status === 'failed',
      ),
    )
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-token-/)
  } finally {
    await f.close()
  }
})

test('CLI refuses to overwrite a token file with its report', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teaching-verifier-'))
  const file = path.join(directory, 'private-token.txt')
  try {
    fs.writeFileSync(file, 'test-only-private-token-sentinel')
    await assert.rejects(
      main(['--api', 'http://127.0.0.1:1/api', '--token-file', file, '--output', file]),
      /must_not_overwrite_token_file/,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), 'test-only-private-token-sentinel')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
