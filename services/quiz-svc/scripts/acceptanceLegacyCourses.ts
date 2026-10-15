/**
 * Final real HTTP + Docker acceptance of the converted courses in the rehearsal database.
 * Requires all twenty conversions to be published first. Never runs during conversion.
 * --api http://127.0.0.1:14003/api --token-file PRIVATE_ADMIN_TOKEN
 * --conversion-state CONVERSION_JSON --metadata METADATA_JSON (repeatable)
 * --state PRIVATE_RESUME_JSON [--report PUBLIC_REPORT_JSON] [--acceptance CODE_MAPPING_JSON]
 * --rehearsal (required explicit guard; this creates two fresh test students and submissions).
 *
 * No application/DB imports, no internal runner calls, no mock grading, no existing-user edits.
 * Resume uses saved random account credentials and server submission idempotency keys.
 * The private state contains test passwords; keep it 0600 and exclude it from production migration.
 * The separate report contains only allowlisted evidence, identifiers, metrics and code hashes.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

type Json = any
type Actor = { token: string; user: { id: string; username: string; role?: string } }
export const LEGACY_ACCEPTANCE_IDS = [
  'AGENDABOT-AD-ATK',
  'AGENDABOT-AD-DEF',
  'CHATOPS-AD-ATK',
  'CHATOPS-AD-DEF',
  'SUPPORTBOT-AD-ATK',
  'SUPPORTBOT-AD-DEF',
  'WEBBOT-AD-ATK',
  'WEBBOT-AD-DEF',
  'DEEPFAKE-AD',
  'DEEPFAKE-AD-DEF',
  'DEEPFAKE-IMG',
  'DEEPFAKE-IMG-DEF',
  'MNIST-BD',
  'MNIST-BD-DEF',
  'MNIST-POISON',
  'MNIST-POISON-DEF',
  'PATCH-AD',
  'PATCH-AD-DEF',
  'WATERMARK-AD',
  'WATERMARK-AD-DEF',
] as const
const liveIds = ['CHATOPS-AD-ATK', 'CHATOPS-AD-DEF', 'MNIST-BD', 'MNIST-BD-DEF']
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const canonical = (value: Json): string =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
    : JSON.stringify(value)

export function assertPublishedLegacyQuestion(question: Json, row: Json, frozen: Json, publicView = true) {
  assert.equal(question.id, row.questionId)
  assert.equal(question.status, 'published')
  assert.equal(question.category, 'adversarial')
  assert.equal(question.scenarioId, row.scenarioId)
  assert.equal(question.role, row.role)
  assert.equal(question.revision, frozen.published?.revision, 'Published revision changed')
  assert.equal(question.revision, frozen.before.revision + 1, 'Legacy conversion must advance one revision')
  assert.equal(question.evaluationVersion, frozen.definition.evaluation.version)
  assert.equal(question.definition.kind, frozen.definition.kind)
  const actual = question.definition.evaluation,
    expected = frozen.definition.evaluation
  for (const key of [
    'version',
    'baselineMetric',
    'baselineThreshold',
    'successMetric',
    'successThreshold',
    'timeoutMs',
    'repetitions',
    'maxScore',
  ])
    assert.equal(actual[key], expected[key], `Frozen evaluation field differs: ${key}`)
  assert.ok(Number.isFinite(actual.baselineThreshold) && Number.isFinite(actual.successThreshold))
  assert.equal(question.definition.llm.enabled, frozen.definition.llm.enabled)
  assert.ok(typeof question.answerTemplate === 'string' && question.answerTemplate.trim())
  if (publicView) {
    for (const key of [
      'packageId',
      'packageDigest',
      'baselineCode',
      'baselineFixture',
      'baselineWeightFixture',
      'calibrationMode',
    ])
      assert.equal(actual[key], undefined, `Public evaluation leaked ${key}`)
    assert.equal(question.definition.llm.poolId, undefined)
    assert.equal(question.definition.teacherApi.poolId, undefined)
    assert.equal(question.solution, undefined)
  } else {
    assert.equal(actual.packageId, frozen.packageId)
    assert.equal(actual.packageDigest, frozen.packageDigest)
    assert.equal(actual.calibrationMode, undefined)
    assert.equal(
      canonical(question.definition),
      canonical({ ...frozen.definition, evaluation: { ...expected, packageDigest: frozen.packageDigest } }),
      'Published administrator contract differs from the frozen verification contract',
    )
  }
}

export function assertCountedArenaScore(
  score: Json,
  submissionId: string,
  opponentCount: number,
  expected?: number,
) {
  assert.equal(score.counted, true)
  assert.equal(score.qualified, true)
  assert.equal(score.updating, false)
  assert.equal(score.status, 'completed')
  assert.equal(score.activeSubmissionId, submissionId)
  assert.equal(score.opponentCount, opponentCount)
  assert.equal(score.emptyPool, opponentCount === 0)
  assert.ok(
    Number.isInteger(score.successCount) && score.successCount >= 0 && score.successCount <= opponentCount,
  )
  const calculated = opponentCount === 0 ? 100 : (score.successCount / opponentCount) * 100
  assert.equal(score.score, calculated, 'Score must include every normally completed opponent match')
  if (expected !== undefined) assert.equal(score.score, expected)
}

/** A real one-opponent match must reproduce its frozen same-code publication self-test. */
export function expectedLegacyArenaScore(questionId: string, frozen: Json): number {
  assert.ok(liveIds.includes(questionId), 'Expected-score binding is limited to the four live courses')
  const proof = frozen?.verification?.opponent
  assert.ok(frozen?.verifiedAt && typeof frozen?.verifiedMaterial?.codeDigest === 'string')
  assert.equal(
    proof?.codeDigest,
    frozen.verifiedMaterial.codeDigest,
    'Frozen opponent proof used different student code',
  )
  assert.equal(proof?.record?.status, 'completed')
  assert.equal(proof?.record?.result?.status, 'completed')
  assert.equal(proof?.record?.result?.cleanupStatus, 'cleaned')
  const success = proof.record.result.success
  assert.equal(typeof success, 'boolean', 'Frozen opponent proof must contain an actual success boolean')
  if (questionId === 'CHATOPS-AD-ATK')
    assert.equal(success, false, 'ChatOps official attack must fail the approved .05 threshold')
  if (questionId === 'CHATOPS-AD-DEF')
    assert.equal(success, true, 'ChatOps official defense must retain its successful reference result')
  return success ? 100 : 0
}

export function assertAdminLegacyScores(
  detail: Json,
  userId: string,
  expected: Array<{ questionId: string; submissionId: string; revision: number; score: number }>,
) {
  assert.equal(detail.student.userId, userId)
  assert.equal(detail.student.basicTotalScore, 0)
  assert.equal(detail.student.submittedQuestionCount, expected.length)
  assert.equal(detail.questions.length, expected.length)
  for (const item of expected) {
    const row = detail.questions.find((q: Json) => q.questionId === item.questionId)
    assert.ok(row, `Missing per-question student score: ${item.questionId}`)
    assert.equal(row.category, 'adversarial')
    assert.equal(row.questionVersion, item.revision)
    assert.equal(row.scoreKind, 'current')
    assert.equal(row.state, 'scored')
    assert.equal(row.updating, false)
    assert.equal(row.score, item.score)
    assert.equal(row.scoringSubmissionId, item.submissionId)
    assert.equal(row.submissionCount, 1, 'Resuming must not create duplicate submissions')
    assert.equal(row.currentSubmissionCount, 1)
    assert.equal(row.latestSubmission.id, item.submissionId)
    for (const key of ['code', 'filePath', 'configSnapshot'])
      assert.equal(row.latestSubmission[key], undefined)
  }
}

function regularFile(file: string, privateFile = false, maxBytes = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file)
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    'Expected a bounded regular file',
  )
  if (privateFile && process.platform !== 'win32')
    assert.equal(stat.mode & 0o077, 0, 'Credential/resume files must be private (0600)')
  return fs.readFileSync(file, 'utf8')
}
function readCode(file: string) {
  const code = regularFile(file, false, 1024 * 1024)
  assert.ok(code.trim() && !code.includes('\uFFFD'), 'Invalid UTF-8 code')
  return code
}
function atomicWrite(file: string, value: Json) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(file + '.tmp', 0o600)
  fs.renameSync(file + '.tmp', file)
}
class HttpFailure extends Error {
  constructor(
    public status: number,
    route: string,
    code: unknown,
  ) {
    super(`${route}: HTTP ${status}, API code ${typeof code === 'number' ? code : 'invalid'}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      api: { type: 'string' },
      'token-file': { type: 'string' },
      'conversion-state': { type: 'string' },
      metadata: { type: 'string', multiple: true },
      acceptance: { type: 'string' },
      state: { type: 'string' },
      report: { type: 'string' },
      'timeout-ms': { type: 'string', default: '3600000' },
      rehearsal: { type: 'boolean' },
    },
  })
  assert.ok(
    values.rehearsal,
    'Explicit --rehearsal is required; never use this against the existing production database',
  )
  assert.ok(
    values.api &&
      values['token-file'] &&
      values['conversion-state'] &&
      values.metadata?.length &&
      values.state,
    'Required: --api --token-file --conversion-state --metadata (repeatable) --state --rehearsal',
  )
  const target = values.api.replace(/\/$/, ''),
    url = new URL(target)
  assert.ok(
    ['http:', 'https:'].includes(url.protocol) &&
      url.pathname === '/api' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  )
  const timeoutMs = Number(values['timeout-ms'])
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10000 && timeoutMs <= 7200000)
  const token = regularFile(values['token-file'], true, 16384).trim()
  assert.ok(token && !/\s/.test(token), 'Invalid administrator token file')
  const conversion = JSON.parse(regularFile(values['conversion-state'], true, 64 * 1024 * 1024))
  assert.equal(conversion.target, target, 'Conversion evidence belongs to another target')
  const rows: Json[] = values.metadata.flatMap((file) => JSON.parse(regularFile(file)))
  assert.equal(rows.length, LEGACY_ACCEPTANCE_IDS.length)
  assert.deepEqual(
    rows.map((r) => r.questionId).sort(),
    [...LEGACY_ACCEPTANCE_IDS].sort(),
    'Only the original twenty course IDs are permitted',
  )
  const mapping = values.acceptance ? JSON.parse(regularFile(values.acceptance)) : {}
  assert.ok(mapping && typeof mapping === 'object' && !Array.isArray(mapping))
  for (const [id, file] of Object.entries(mapping))
    assert.ok(
      rows.some((r) => r.questionId === id) && typeof file === 'string' && file.trim(),
      'Invalid acceptance-code mapping',
    )
  const codes: Record<string, string> = {},
    codeDigests: Record<string, string> = {}
  for (const row of rows) {
    const frozen = conversion.questions[row.questionId]
    assert.ok(
      frozen?.published?.revision &&
        frozen.verifiedAt &&
        frozen.verifiedMaterial?.codeDigest &&
        frozen.definition,
      `Conversion not published/verified: ${row.questionId}`,
    )
    assert.ok(!frozen.definition.evaluation.calibrationMode, 'Calibration placeholder cannot be accepted')
    const file = mapping[row.questionId]
      ? path.resolve(path.dirname(path.resolve(values.acceptance!)), mapping[row.questionId])
      : row.referenceCodePath
    codes[row.questionId] = readCode(file)
    codeDigests[row.questionId] = digest(codes[row.questionId])
    assert.equal(
      codeDigests[row.questionId],
      frozen.verifiedMaterial.codeDigest,
      'Acceptance code differs from the published verification evidence',
    )
  }
  const expectedFinalScores = Object.fromEntries(
    liveIds.map((id) => [id, expectedLegacyArenaScore(id, conversion.questions[id])]),
  )
  const contract = rows.map((row) => ({
    id: row.questionId,
    scenarioId: row.scenarioId,
    role: row.role,
    published: conversion.questions[row.questionId].published,
    definition: conversion.questions[row.questionId].definition,
    packageDigest: conversion.questions[row.questionId].packageDigest,
    codeDigest: codeDigests[row.questionId],
  }))
  const fingerprint = digest(canonical(contract))
  const stateFile = path.resolve(values.state),
    reportFile = path.resolve(values.report || values.state + '.report.json')
  const inputs = [
    values['token-file'],
    values['conversion-state'],
    ...values.metadata,
    ...(values.acceptance ? [values.acceptance] : []),
  ].map((f) => path.resolve(f))
  assert.ok(
    stateFile !== reportFile && !inputs.includes(stateFile) && !inputs.includes(reportFile),
    'Output must not overwrite credentials or source evidence',
  )
  const state: Json = fs.existsSync(stateFile)
    ? JSON.parse(regularFile(stateFile, true))
    : {
        schemaVersion: 1,
        target,
        fingerprint,
        runId: `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
        startedAt: new Date().toISOString(),
        actors: {},
        checks: {},
        submissions: {},
        resources: {},
      }
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.target, target)
  assert.equal(
    state.fingerprint,
    fingerprint,
    'Frozen conversion/code changed; do not reuse this acceptance run',
  )
  const secrets = [token, ...Object.values(state.actors).map((a: Json) => a.password)]
  const redact = (error: unknown) => {
    let message = error instanceof Error ? error.message : 'Acceptance failed'
    for (const secret of secrets) if (secret) message = message.split(secret).join('[REDACTED]')
    return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 1000)
  }
  function save() {
    state.updatedAt = new Date().toISOString()
    atomicWrite(stateFile, state)
    const checks: Json[] = Object.values(state.checks)
    atomicWrite(reportFile, {
      schemaVersion: 1,
      target,
      runId: state.runId,
      fingerprint,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      mode: 'real-http-docker-legacy-courses',
      scope:
        'Twenty published configurations/resources; four real course submissions from two fresh rehearsal-only students.',
      limitations: [
        'Sixteen other questions rely on the conversion runner’s real Docker self-test evidence; they are not submitted again here.',
        'Existing real-user accounts are not edited; test accounts/submissions must not be copied to production.',
        'Resource checks verify the current published list and download availability, not equality with an unprovided pre-upgrade resource manifest.',
      ],
      students: Object.entries(state.actors).map(([label, a]: [string, Json]) => ({
        label,
        userId: a.userId,
        username: a.username,
      })),
      submissionIds: Object.values(state.submissions)
        .map((s: Json) => s.id)
        .filter(Boolean),
      codeDigests,
      expectedFinalScores,
      summary: {
        passed: checks.filter((c) => c.status === 'passed').length,
        failed: checks.filter((c) => c.status === 'failed').length,
      },
      checks,
    })
  }
  async function request(route: string, actor?: Actor, method = 'GET', body?: Json, expectedStatus?: number) {
    const multipart = body instanceof FormData
    const response = await fetch(target + route, {
      method,
      redirect: 'error',
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    const result = (await response.json().catch(() => ({ code: 'non_json' }))) as Json
    if (expectedStatus !== undefined) {
      assert.equal(response.status, expectedStatus)
      return result
    }
    if (!response.ok || result.code !== 0) throw new HttpFailure(response.status, route, result.code)
    return result.data
  }
  async function check(id: string, action: () => Promise<Json>, revalidate = false) {
    if (!revalidate && state.checks[id]?.status === 'passed') return state.checks[id].evidence
    const start = Date.now()
    state.checks[id] = {
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: (state.checks[id]?.attempts || 0) + 1,
    }
    save()
    try {
      const evidence = await action()
      Object.assign(state.checks[id], { status: 'passed', durationMs: Date.now() - start, evidence })
      save()
      console.log(JSON.stringify({ case: id, status: 'passed', durationMs: Date.now() - start }))
      return evidence
    } catch (error) {
      Object.assign(state.checks[id], {
        status: 'failed',
        durationMs: Date.now() - start,
        error: redact(error),
      })
      save()
      throw error
    }
  }
  async function poll(label: string, read: () => Promise<Json>, done: (value: Json) => boolean) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await read()
      if (done(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`${label}: timeout; resume using the same private state (no duplicate submission)`)
  }
  let admin: Actor = { token, user: { id: '', username: '' } }
  const actors: Record<string, Actor> = {},
    questions: Record<string, Json> = {}
  try {
    await check(
      'published-preflight',
      async () => {
        const me = await request('/auth/me', admin)
        assert.equal(me.user?.role, 'admin', 'Token must identify an existing administrator')
        admin.user = me.user
        for (const row of rows) {
          const q = await request(`/admin/questions/${row.questionId}`, admin)
          assertPublishedLegacyQuestion(q, row, conversion.questions[row.questionId], false)
        }
        return { publishedCount: rows.length, administratorVerified: true }
      },
      true,
    )
    for (const label of ['a', 'b']) {
      let stored = state.actors[label]
      if (!stored) {
        stored = state.actors[label] = {
          username: `legacy${state.runId}${label}`,
          password: `T!${crypto.randomBytes(24).toString('hex')}`,
        }
        secrets.push(stored.password)
        save()
      }
      // Login first recovers an interrupted registration without generating another account.
      let actor: Actor | undefined
      try {
        actor = await request('/auth/login', undefined, 'POST', {
          username: stored.username,
          password: stored.password,
          role: 'student',
        })
      } catch (error) {
        if (stored.userId || !(error instanceof HttpFailure) || ![400, 401].includes(error.status))
          throw error
        try {
          await request('/auth/register', undefined, 'POST', {
            username: stored.username,
            password: stored.password,
            displayName: `Legacy acceptance ${state.runId} ${label}`,
            school: 'Rehearsal acceptance',
            studentId: `001${label === 'a' ? '1' : '2'}`,
          })
        } catch (registerError) {
          if (!(registerError instanceof HttpFailure) || registerError.status !== 400) throw registerError
        }
        actor = await request('/auth/login', undefined, 'POST', {
          username: stored.username,
          password: stored.password,
          role: 'student',
        })
      }
      assert.ok(actor?.token && actor.user?.id)
      assert.equal(actor.user.username, stored.username)
      assert.equal(actor.user.role, 'student')
      if (stored.userId) assert.equal(stored.userId, actor.user.id)
      stored.userId = actor.user.id
      actors[label] = actor
      secrets.push(actor.token)
      save()
    }
    await check(
      'public-question-list',
      async () => {
        const list = await request('/questions?category=adversarial', actors.a)
        for (const row of rows) {
          const matches = list.filter((q: Json) => q.id === row.questionId)
          assert.equal(matches.length, 1, 'Every attack/defense slot must be listed as its own question')
          assertPublishedLegacyQuestion(matches[0], row, conversion.questions[row.questionId])
        }
        return { convertedSlotsVisible: rows.length, distinctAttackDefenseQuestions: true }
      },
      true,
    )
    for (const row of rows)
      await check(
        `public-${row.questionId}`,
        async () => {
          const q = await request(`/questions/${row.questionId}`, actors.a)
          assertPublishedLegacyQuestion(q, row, conversion.questions[row.questionId])
          questions[row.questionId] = q
          const resources = await request(`/questions/${row.questionId}/resources`, actors.a)
          assert.ok(Array.isArray(resources))
          const names = new Set()
          for (const resource of resources) {
            assert.ok(
              typeof resource.filename === 'string' && resource.filename && !/[\\/]/.test(resource.filename),
            )
            assert.ok(
              Number.isSafeInteger(resource.size) && resource.size >= 0 && !names.has(resource.filename),
            )
            names.add(resource.filename)
            const response = await fetch(
              `${target}/questions/${row.questionId}/resources/${encodeURIComponent(resource.filename)}`,
              { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) },
            )
            assert.equal(response.status, 200, 'Published resource download unavailable')
            assert.notEqual(response.headers.get('content-length'), null)
            assert.equal(Number(response.headers.get('content-length')), resource.size)
          }
          const inventory = resources
            .map((r: Json) => ({ filename: r.filename, size: r.size }))
            .sort((a: Json, b: Json) => a.filename.localeCompare(b.filename))
          if (state.resources[row.questionId])
            assert.deepEqual(
              inventory,
              state.resources[row.questionId],
              'Resource inventory changed while resuming',
            )
          state.resources[row.questionId] = inventory
          return {
            questionId: q.id,
            role: q.role,
            scenarioId: q.scenarioId,
            revision: q.revision,
            evaluationVersion: q.evaluationVersion,
            baselineThreshold: q.definition.evaluation.baselineThreshold,
            successThreshold: q.definition.evaluation.successThreshold,
            resources: inventory,
          }
        },
        true,
      )
    await check(
      'rehearsal-pools-owned',
      async () => {
        const owned = new Set(Object.values(actors).map((a) => a.user.id))
        for (const id of liveIds) {
          const leaderboard = await request(`/arena/questions/${id}/leaderboard?limit=500`, actors.a)
          assert.ok(Array.isArray(leaderboard) && leaderboard.length < 500)
          assert.ok(
            leaderboard.every((r: Json) => owned.has(r.userId)),
            'A tested pool contains unrelated users; stop rather than change their scores',
          )
        }
        return { isolatedPools: liveIds }
      },
      true,
    )
    await check(
      'admin-score-permissions',
      async () => {
        await request('/admin/student-scores', undefined, 'GET', undefined, 403)
        await request(`/admin/student-scores/${actors.a.user.id}`, actors.a, 'GET', undefined, 403)
        return { anonymousStatus: 403, studentStatus: 403 }
      },
      true,
    )

    function submissionForm(id: string, label: string) {
      const form = new FormData()
      form.append('questionId', id)
      form.append('questionVersion', String(questions[id].revision))
      form.append('code', codes[id])
      form.append('idempotencyKey', `legacy_${state.runId}_${label}`)
      return form
    }
    async function submit(id: string, label: string, actor: Actor) {
      const known = state.submissions[label]
      const created = await request('/submissions', actor, 'POST', submissionForm(id, label))
      if (known) assert.equal(created.id, known.id, 'Idempotent replay created a duplicate')
      state.submissions[label] = {
        id: created.id,
        questionId: id,
        userId: actor.user.id,
        codeDigest: codeDigests[id],
      }
      save()
      const result = await poll(
        `${id} submission`,
        async () => {
          const tasks = await request('/admin/evaluation-tasks', admin)
          const task = tasks.find((r: Json) => r.submissionId === created.id)
          if (!task || !['completed', 'error'].includes(task.state)) return null
          const final = await request(`/submissions/${created.id}`, actor)
          return ['queued', 'pending', 'judging', 'baseline', 'opponents'].includes(final.status)
            ? null
            : final
        },
        (value) => value !== null,
      )
      assert.equal(result.status, 'completed', `${id}: submission did not produce a normal result`)
      assert.equal(result.result?.qualified, true, `${id}: published verification code failed qualification`)
      return { submissionId: created.id, questionId: id, codeDigest: codeDigests[id] }
    }
    async function score(id: string, actor: Actor, label: string, count: number, expected?: number) {
      const submissionId = state.submissions[label].id
      const result = await poll(
        `${id} final score`,
        () => request(`/arena/questions/${id}/score`, actor),
        (s) => s.updating === false && s.activeSubmissionId === submissionId && s.opponentCount === count,
      )
      assertCountedArenaScore(result, submissionId, count, expected)
      return result
    }
    for (const [prefix, attackId, defenseId] of [
      ['chatops', 'CHATOPS-AD-ATK', 'CHATOPS-AD-DEF'],
      ['backdoor', 'MNIST-BD', 'MNIST-BD-DEF'],
    ]) {
      await check(`${prefix}-empty-pool`, async () => {
        const submitted = await submit(attackId, `${prefix}_attack`, actors.a)
        const result = await score(attackId, actors.a, `${prefix}_attack`, 0, 100)
        return {
          ...submitted,
          score: result.score,
          opponentCount: 0,
          successCount: result.successCount,
          emptyPool: true,
        }
      })
      await check(`${prefix}-defender-enters`, async () => {
        const submitted = await submit(defenseId, `${prefix}_defense`, actors.b)
        const attack = await score(attackId, actors.a, `${prefix}_attack`, 1, expectedFinalScores[attackId])
        const defense = await score(
          defenseId,
          actors.b,
          `${prefix}_defense`,
          1,
          expectedFinalScores[defenseId],
        )
        return {
          ...submitted,
          attack: {
            score: attack.score,
            expectedScore: expectedFinalScores[attackId],
            successCount: attack.successCount,
            opponentCount: attack.opponentCount,
            counted: attack.counted,
          },
          defense: {
            score: defense.score,
            expectedScore: expectedFinalScores[defenseId],
            successCount: defense.successCount,
            opponentCount: defense.opponentCount,
            counted: defense.counted,
          },
        }
      })
    }
    await check(
      'idempotency-replay',
      async () => {
        for (const [label, entry] of Object.entries(state.submissions) as Array<[string, Json]>) {
          const actor = Object.values(actors).find((a) => a.user.id === entry.userId)!
          const replay = await request('/submissions', actor, 'POST', submissionForm(entry.questionId, label))
          assert.equal(replay.id, entry.id)
          const history = await request(`/questions/${entry.questionId}/submissions`, actor)
          assert.equal(history.length, 1, 'Resumed acceptance produced duplicate material')
        }
        return { submissions: Object.keys(state.submissions).length, duplicates: 0 }
      },
      true,
    )
    for (const label of ['a', 'b'])
      await check(
        `admin-per-question-${label}`,
        async () => {
          const actor = actors[label],
            expected = []
          for (const [key, entry] of Object.entries(state.submissions) as Array<[string, Json]>) {
            if (entry.userId !== actor.user.id) continue
            const current = await score(
              entry.questionId,
              actor,
              key,
              1,
              expectedFinalScores[entry.questionId],
            )
            expected.push({
              questionId: entry.questionId,
              submissionId: entry.id,
              revision: questions[entry.questionId].revision,
              score: current.score,
            })
            const leaderboard = await request(`/arena/questions/${entry.questionId}/leaderboard`, actor)
            const row = leaderboard.find((r: Json) => r.userId === actor.user.id)
            assert.ok(row && row.score === current.score && row.opponentCount === 1)
          }
          const detail = await request(`/admin/student-scores/${actor.user.id}`, admin)
          assertAdminLegacyScores(detail, actor.user.id, expected)
          const summary = await request(
            `/admin/student-scores?search=${encodeURIComponent(actor.user.username)}`,
            admin,
          )
          assert.equal(summary.total, 1)
          assert.equal(summary.students[0].userId, actor.user.id)
          assert.equal(summary.students[0].submittedQuestionCount, 2)
          assert.equal(summary.students[0].basicTotalScore, 0)
          return { userId: actor.user.id, questions: expected, basicTotalScore: 0 }
        },
        true,
      )
    state.completedAt = new Date().toISOString()
    save()
    console.log(
      JSON.stringify({
        status: 'passed',
        publishedQuestions: rows.length,
        realSubmissions: Object.keys(state.submissions).length,
        report: reportFile,
      }),
    )
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: redact(error), report: reportFile }))
    throw new Error(
      'Legacy acceptance failed; inspect the redacted report and resume with the same private state',
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Legacy acceptance failed')
    process.exitCode = 1
  })
