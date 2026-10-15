/**
 * Real HTTP + Docker acceptance against a separately deployed test instance.
 * Required: PRD_TEST_URL (including /api), and either PRD_TEST_ADMIN_TOKEN_FILE or
 * PRD_TEST_ADMIN_USERNAME / PRD_TEST_ADMIN_PASSWORD.
 * Optional: PRD_TEST_REPORT, PRD_TEST_TIMEOUT_MS (default 180000 per asynchronous operation).
 * Run: pnpm --filter quiz-svc exec tsx scripts/acceptancePrd.ts
 * Creates only fresh prdtest_<runId> questions/scenarios and prdtest<runId> users.
 * Leaves its own evidence available for inspection; never clears, deletes, or migrates existing data.
 * Imports no application modules, reads no .env/DB credentials, and never bypasses the HTTP worker.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

type Json = any
type Actor = { token: string; user: { id: string; username: string } }
type CaseResult = {
  id: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  startedAt: string
  durationMs: number
  evidence?: Json
  error?: string
}
const startedAt = new Date().toISOString()
const runId = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
const prefix = `prdtest_${runId}`
const base = (process.env.PRD_TEST_URL || '').replace(/\/$/, '')
const reportPath = path.resolve(
  process.env.PRD_TEST_REPORT || `.test-artifacts/server-acceptance-${runId}.json`,
)
const operationTimeout = Number(process.env.PRD_TEST_TIMEOUT_MS || 180000)
const secrets: string[] = []
const cases: CaseResult[] = []
const resources: {
  questionIds: string[]
  userIds: string[]
  packageIds: string[]
  submissionIds: string[]
  selfTestIds: string[]
} = { questionIds: [], userIds: [], packageIds: [], submissionIds: [], selfTestIds: [] }
let admin: Actor | undefined, a: Actor | undefined, b: Actor | undefined
const packages: Record<string, Json> = {}
const questions: Record<string, Json> = {}
const submissions: Record<string, Json> = {}

function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 1200)
}
function writeReport() {
  const report = {
    schemaVersion: 1,
    runId,
    target: base,
    startedAt,
    updatedAt: new Date().toISOString(),
    mode: 'real-http-docker',
    scope: 'Fresh isolated acceptance fixtures only; no production migration or legacy data edits.',
    limitations: [
      'Uses actual isolated Python containers and deterministic teaching fixtures.',
      'Does not claim validation of real external LLMs, GPU/PyTorch course assets, or concurrent capacity.',
      'Teacher/model gateway upstream lifecycle is outside this script.',
    ],
    summary: {
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      skipped: cases.filter((c) => c.status === 'skipped').length,
    },
    resources,
    cases,
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
}
class DependencyMissing extends Error {}
function need<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new DependencyMissing(`Missing prerequisite: ${name}`)
  return value
}
async function check(id: string, name: string, action: () => Promise<Json>) {
  const start = Date.now()
  const result: CaseResult = {
    id,
    name,
    status: 'passed',
    startedAt: new Date().toISOString(),
    durationMs: 0,
  }
  try {
    result.evidence = await action()
  } catch (error) {
    result.status = error instanceof DependencyMissing ? 'skipped' : 'failed'
    result.error = redact(error)
  }
  result.durationMs = Date.now() - start
  cases.push(result)
  writeReport()
  console.log(
    JSON.stringify({ case: id, status: result.status, durationMs: result.durationMs, error: result.error }),
  )
}
async function request(
  route: string,
  options: { actor?: Actor; method?: string; body?: Json; expectedStatus?: number } = {},
) {
  const headers: Record<string, string> = {}
  if (options.actor) headers.Authorization = `Bearer ${options.actor.token}`
  const multipart = options.body instanceof FormData
  if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${base}${route}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : multipart ? options.body : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  })
  const body = await response.json().catch(() => ({ message: 'Non-JSON response' }))
  if (options.expectedStatus !== undefined) {
    assert.equal(
      response.status,
      options.expectedStatus,
      `${route}: HTTP ${response.status}: ${body.message}`,
    )
    return body
  }
  if (!response.ok || body.code !== 0)
    throw new Error(`${route}: HTTP ${response.status}, code ${body.code}: ${body.message}`)
  return body.data
}
async function poll<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + operationTimeout
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label}: exceeded ${operationTimeout} ms`)
}
function definition(packageId: string, model = false) {
  return {
    kind: model ? 'model' : 'algorithm',
    weights: {
      enabled: model,
      required: model,
      extensions: ['.json'],
      maxBytes: 1048576,
      ...(model
        ? {
            modelStructure: 'y = weight * x + bias',
            weightType: 'JSON numeric weight and bias',
            loadInterface: '/materials/weights.bin',
            device: 'cpu',
            requiredKeys: ['weight', 'bias'],
          }
        : {}),
    },
    teacherApi: { enabled: false, maxCalls: 1000 },
    llm: { enabled: false },
    evaluation: {
      packageId,
      version: 'v1',
      timeoutMs: 10000,
      maxScore: 100,
      baselineMetric: 'qualificationMetric',
      baselineThreshold: 1,
      successMetric: 'successMetric',
      successThreshold: 0.5,
      repetitions: 1,
    },
  }
}
const sumCode = 'def solve(values):\n    return sum(values)\n'
const lowCode = 'def solve(values):\n    return 0\n'
const modelCode =
  "import json\nwith open('/materials/weights.bin', encoding='utf8') as f:\n    parameters = json.load(f)\ndef predict(x):\n    return parameters['weight'] * x + parameters['bias']\n"
const attackCode = "def attack():\n    return 'SECRET'\n"
const mixedAttackCode = "def attack():\n    return 'SeCrEt'\n"
const rejectedAttackCode = "def attack():\n    return 'secret'\n"
const strictDefenseCode = "def defend(text):\n    return 'BLOCKED' if 'secret' in text.lower() else text\n"
const weakDefenseCode = "def defend(text):\n    return 'BLOCKED' if text == 'SECRET' else text\n"

async function selfTest(name: string, code: string, role?: 'attack' | 'defense', phase = 'basic') {
  const p = need(packages[name], `${name} package`)
  const body: Json = {
    code,
    category: role ? 'adversarial' : 'basic',
    role,
    phase,
    definition: definition(p.id, name === 'model-inference'),
    ...(name === 'model-inference' ? { weightFixture: 'fixtures/weights.json' } : {}),
    ...(phase === 'opponent'
      ? { opponent: { code: role === 'attack' ? strictDefenseCode : attackCode } }
      : {}),
  }
  const created = await request(`/admin/evaluation-packages/${p.id}/self-tests`, {
    actor: need(admin, 'admin'),
    method: 'POST',
    body,
  })
  resources.selfTestIds.push(created.id)
  const result = await poll<Json>(
    `${name}/${role || 'basic'}/${phase} self-test`,
    () => request(`/admin/evaluation-packages/${p.id}/self-tests/${created.id}`, { actor: admin }),
    (r) => r.status === 'completed',
  )
  assert.equal(result.result?.status, 'completed', `Self-test ${created.id}: ${result.result?.publicMessage}`)
  assert.equal(result.result.cleanupStatus, 'cleaned')
  if (phase === 'basic') assert.equal(result.result.score, 100)
  if (phase === 'baseline') assert.equal(result.result.metrics.qualificationMetric, 1)
  return { selfTestId: created.id, result: result.result }
}
async function createQuestion(key: string, packageName: string, role?: 'attack' | 'defense') {
  const p = need(packages[packageName], `${packageName} package`)
  const id = `${prefix}_${key}`
  const draft = await request('/admin/questions', {
    actor: need(admin, 'admin'),
    method: 'POST',
    body: {
      id,
      moduleCode: prefix,
      number: resources.questionIds.length + 1,
      title: `[PRD acceptance ${runId}] ${key}`,
      content: `Automated acceptance fixture ${runId}. Retain for inspection; not a course question.`,
      type: 'code',
      category: role ? 'adversarial' : 'basic',
      status: 'draft',
      ...(role ? { role, scenarioId: `${prefix}_scenario` } : {}),
      definition: definition(p.id, packageName === 'model-inference'),
    },
  })
  resources.questionIds.push(draft.id)
  questions[key] = draft
  return draft
}
async function publishQuestion(key: string) {
  const q = need(questions[key], `${key} draft`)
  assert.ok(q.id.startsWith(`${prefix}_`))
  const published = await request(`/admin/questions/${q.id}`, {
    actor: need(admin, 'admin'),
    method: 'PUT',
    body: { status: 'published' },
  })
  assert.equal(published.status, 'published')
  questions[key] = published
  return { questionId: published.id, revision: published.revision }
}
function submissionForm(
  question: Json,
  code: string,
  idempotencyKey: string,
  file?: { contents: string; name: string },
) {
  const form = new FormData()
  form.append('questionId', question.id)
  form.append('questionVersion', String(question.revision))
  form.append('code', code)
  form.append('idempotencyKey', idempotencyKey)
  if (file) form.append('file', new Blob([file.contents], { type: 'application/json' }), file.name)
  return form
}
async function submit(
  label: string,
  questionKey: string,
  actor: Actor | undefined,
  code: string,
  file?: { contents: string; name: string },
) {
  const q = need(questions[questionKey], `${questionKey} question`)
  assert.equal(q.status, 'published')
  const key = `${prefix}_${label}`
  const owner = need(actor, 'student')
  const created = await request('/submissions', {
    actor: owner,
    method: 'POST',
    body: submissionForm(q, code, key, file),
  })
  resources.submissionIds.push(created.id)
  const result = await poll<Json>(
    label,
    async () => {
      // Arena attempts briefly publish `error` before the submission worker requeues them.
      // Only this submission's durable task can confirm that its retry budget has finished.
      const tasks = await request('/admin/evaluation-tasks', { actor: need(admin, 'admin') })
      const task = tasks.find((row: Json) => row.submissionId === created.id)
      if (!task || !['completed', 'error'].includes(task.state)) return null
      const final = await request(`/submissions/${created.id}`, { actor: owner })
      if (['pending', 'queued', 'judging', 'baseline', 'opponents'].includes(final.status)) return null
      return final
    },
    (r) => r !== null,
  )
  submissions[label] = result
  return result
}
async function arenaScore(
  questionKey: string,
  actor: Actor | undefined,
  expected: number,
  opponents: number,
) {
  const q = need(questions[questionKey], `${questionKey} question`)
  return poll<Json>(
    `${questionKey} score=${expected}, opponents=${opponents}`,
    () => request(`/arena/questions/${q.id}/score`, { actor: need(actor, 'student') }),
    (r) => r.score === expected && r.opponentCount === opponents && r.updating === false,
  )
}

async function main() {
  await check('setup', 'Explicit target and administrator login', async () => {
    assert.ok(base && /^https?:\/\//.test(base), 'PRD_TEST_URL must be an explicit HTTP(S) API URL')
    const target = new URL(base)
    assert.equal(target.pathname.replace(/\/$/, ''), '/api', 'PRD_TEST_URL must end in /api')
    assert.ok(
      !target.username && !target.password && !target.search && !target.hash,
      'No URL credentials/query',
    )
    assert.ok(Number.isFinite(operationTimeout) && operationTimeout >= 10000 && operationTimeout <= 600000)
    const tokenFile = process.env.PRD_TEST_ADMIN_TOKEN_FILE
    if (tokenFile) {
      const stat = fs.lstatSync(tokenFile)
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384,
        'Invalid administrator token file',
      )
      if (process.platform !== 'win32')
        assert.equal(stat.mode & 0o077, 0, 'Token file must be private (0600)')
      const token = fs.readFileSync(tokenFile, 'utf8').trim()
      assert.ok(token && !/\s/.test(token), 'Invalid administrator token')
      secrets.push(token)
      const identity = await request('/auth/me', { actor: { token, user: { id: '', username: '' } } })
      assert.equal(identity.user?.role, 'admin', 'Token must identify an existing administrator')
      admin = { token, user: identity.user }
    } else {
      const username = process.env.PRD_TEST_ADMIN_USERNAME
      const password = process.env.PRD_TEST_ADMIN_PASSWORD
      assert.ok(username && password, 'Administrator token file or username/password are required')
      secrets.push(password)
      admin = await request('/auth/login', { method: 'POST', body: { username, password, role: 'admin' } })
      secrets.push(need(admin, 'admin').token)
      const identity = await request('/auth/me', { actor: admin })
      assert.equal(identity.user?.role, 'admin')
    }
    return { target: base, freshFixturePrefix: prefix }
  })
  for (const label of ['a', 'b']) {
    await check(`register-${label}`, `Create fresh acceptance student ${label.toUpperCase()}`, async () => {
      need(admin, 'successful admin login')
      const username = `prdtest${runId}${label}`
      const password = `T!${crypto.randomBytes(20).toString('hex')}`
      secrets.push(password)
      const registered = await request('/auth/register', {
        method: 'POST',
        body: {
          username,
          password,
          displayName: `PRD ${runId} ${label}`,
          school: 'Acceptance test',
          studentId: '00123',
        },
      })
      resources.userIds.push(registered.user.id)
      const actor = await request('/auth/login', {
        method: 'POST',
        body: { username, password, role: 'student' },
      })
      secrets.push(actor.token)
      if (label === 'a') a = actor
      else b = actor
      assert.equal(registered.user.studentId, '00123')
      assert.equal(registered.user.phone, null)
      return { userId: registered.user.id, studentIdPreserved: true, phoneOptional: true }
    })
  }
  await check('permissions', 'Anonymous/student users cannot reach administrator package APIs', async () => {
    need(admin, 'successful admin login')
    await request('/admin/evaluation-packages', { expectedStatus: 403 })
    await request('/admin/evaluation-packages', { actor: need(a, 'student A'), expectedStatus: 403 })
    return { anonymousStatus: 403, studentStatus: 403 }
  })
  await check(
    'admin-student-empty',
    'Only administrators can inspect student scores, including empty accounts',
    async () => {
      const actor = need(a, 'student A')
      await request('/admin/student-scores', { expectedStatus: 403 })
      await request(`/admin/student-scores/${actor.user.id}`, { actor, expectedStatus: 403 })
      const list = await request(`/admin/student-scores?search=${encodeURIComponent(actor.user.username)}`, {
        actor: need(admin, 'admin'),
      })
      assert.equal(list.total, 1)
      assert.equal(list.students[0].userId, actor.user.id)
      assert.equal(list.students[0].basicTotalScore, 0)
      assert.equal(list.students[0].studentId, '00123')
      const detail = await request(`/admin/student-scores/${actor.user.id}`, { actor: admin })
      assert.deepEqual(detail.questions, [])
      return { userId: actor.user.id, adminOnly: true, noSubmissions: true, studentIdPreserved: true }
    },
  )
  for (const name of ['basic-algorithm', 'model-inference', 'attack-defense']) {
    await check(`import-${name}`, `Import and validate ${name} environment package`, async () => {
      const descriptor = await request(`/admin/evaluation-packages/examples/${name}`, {
        actor: need(admin, 'admin'),
        method: 'POST',
        body: {},
      })
      packages[name] = descriptor
      resources.packageIds.push(descriptor.id)
      const validated = await request(`/admin/evaluation-packages/${descriptor.id}/validate`, {
        actor: admin,
        method: 'POST',
        body: {},
      })
      assert.equal(validated.digest, descriptor.digest)
      assert.equal(descriptor.manifest.protocol, 'platform-rpc-v1')
      return { packageId: descriptor.id, digest: descriptor.digest, checks: validated.checks }
    })
  }
  for (const [key, name, role] of [
    ['basic', 'basic-algorithm', undefined],
    ['model', 'model-inference', undefined],
    ['attack', 'attack-defense', 'attack'],
    ['defense', 'attack-defense', 'defense'],
  ] as const) {
    await check(`draft-${key}`, `Create ${key} draft`, async () => {
      const q = await createQuestion(key, name, role)
      return { questionId: q.id, revision: q.revision }
    })
  }
  await check(
    'publish-gate',
    'A fresh configuration cannot publish without a matching successful self-test',
    async () => {
      const q = need(questions.basic, 'basic draft')
      // A deliberately unique maxScore prevents earlier runs from supplying matching evidence.
      const modified = definition(need(packages['basic-algorithm'], 'basic package').id)
      modified.evaluation.maxScore = 101 + Number.parseInt(runId.slice(-6), 16)
      const blocked = await request(`/admin/questions/${q.id}`, {
        actor: need(admin, 'admin'),
        method: 'PUT',
        body: { status: 'published', definition: modified },
        expectedStatus: 400,
      })
      assert.match(blocked.message, /自测/)
      return { status: 400, message: blocked.message }
    },
  )
  await check('self-test-basic', 'Real Docker basic self-test scores 100 and cleans up', () =>
    selfTest('basic-algorithm', sumCode),
  )
  await check('self-test-model', 'Real Docker JSON model self-test scores 100 and cleans up', () =>
    selfTest('model-inference', modelCode),
  )
  for (const role of ['attack', 'defense'] as const)
    for (const phase of ['baseline', 'opponent'])
      await check(`self-test-${role}-${phase}`, `Real Docker ${role}/${phase} self-test`, () =>
        selfTest('attack-defense', role === 'attack' ? attackCode : strictDefenseCode, role, phase),
      )
  for (const key of ['basic', 'model', 'attack', 'defense'])
    await check(`publish-${key}`, `Publish ${key} with matching evidence`, () => publishQuestion(key))

  await check('basic-high', 'Real unified submission produces basic score 100', async () => {
    const result = await submit('basicHigh', 'basic', a, sumCode)
    assert.equal(result.status, 'completed')
    assert.equal(result.score, 100)
    const rank = await request(`/leaderboard/my-rank?userId=${need(a, 'A').user.id}`)
    assert.equal(rank.totalScore, 100)
    submissions.basicRank = rank
    return { submissionId: result.id, score: result.score, rank }
  })
  await check(
    'basic-idempotency',
    'Replayed material returns the same submission; changed material is rejected',
    async () => {
      const result = need(submissions.basicHigh, 'basic high submission')
      const q = need(questions.basic, 'basic question')
      const replay = await request('/submissions', {
        actor: need(a, 'A'),
        method: 'POST',
        body: submissionForm(q, sumCode, `${prefix}_basicHigh`),
      })
      assert.equal(replay.id, result.id)
      await request('/submissions', {
        actor: a,
        method: 'POST',
        body: submissionForm(q, lowCode, `${prefix}_basicHigh`),
        expectedStatus: 409,
      })
      await request(`/submissions/${result.id}`, { actor: need(b, 'B'), expectedStatus: 404 })
      return { submissionId: replay.id, conflictingReplay: 409, crossUserRead: 404 }
    },
  )
  await check(
    'basic-lower',
    'Lower real score 40 preserves the highest score and its reached timestamp',
    async () => {
      const before = need(submissions.basicRank, 'initial rank')
      const result = await submit('basicLow', 'basic', a, lowCode)
      assert.equal(result.status, 'completed')
      assert.equal(result.score, 40)
      const rank = await request(`/leaderboard/my-rank?userId=${need(a, 'A').user.id}`)
      assert.equal(rank.totalScore, 100)
      assert.equal(rank.scoreReachedAt, before.scoreReachedAt)
      const hall = await request('/questions', { actor: a })
      assert.equal(hall.find((q: Json) => q.id === questions.basic.id)?.myScore, 100)
      return { submissionId: result.id, attemptScore: 40, retainedBest: 100, unchangedReachedAt: true }
    },
  )
  await check('basic-tie-order', 'Later equal score ranks below the earlier score', async () => {
    need(submissions.basicRank, 'A initial rank')
    const result = await submit('basicB', 'basic', b, sumCode)
    assert.equal(result.score, 100)
    const rankA = await request(`/leaderboard/my-rank?userId=${need(a, 'A').user.id}`)
    const rankB = await request(`/leaderboard/my-rank?userId=${need(b, 'B').user.id}`)
    assert.equal(rankA.totalScore, rankB.totalScore)
    assert.ok(rankA.rank < rankB.rank)
    return { rankA: rankA.rank, rankB: rankB.rank, equalScore: 100 }
  })
  await check(
    'admin-student-basic',
    'Administrator per-question detail keeps the best score and latest attempt separate',
    async () => {
      need(submissions.basicLow, 'lower submission')
      const detail = await request(`/admin/student-scores/${need(a, 'A').user.id}`, {
        actor: need(admin, 'admin'),
      })
      const row = detail.questions.find((q: Json) => q.questionId === questions.basic.id)
      assert.equal(detail.student.basicTotalScore, 100)
      assert.equal(row.score, 100)
      assert.equal(row.scoreKind, 'best')
      assert.equal(row.submissionCount, 2)
      assert.equal(row.latestSubmission.score, 40)
      assert.equal(row.state, 'scored')
      assert.equal(row.latestSubmission.code, undefined)
      assert.equal(row.latestSubmission.filePath, undefined)
      return { best: row.score, latestAttempt: row.latestSubmission.score, submissions: row.submissionCount }
    },
  )
  await check('basic-weights-forbidden', 'Algorithm question rejects undeclared model upload', async () => {
    await request('/submissions', {
      actor: need(a, 'A'),
      method: 'POST',
      body: submissionForm(need(questions.basic, 'basic question'), sumCode, `${prefix}_noWeights`, {
        contents: '{}',
        name: 'weights.json',
      }),
      expectedStatus: 400,
    })
    return { status: 400 }
  })
  await check(
    'model-upload-rules',
    'Model question requires JSON weights and rejects a mismatched extension',
    async () => {
      const q = need(questions.model, 'model question')
      await request('/submissions', {
        actor: need(a, 'A'),
        method: 'POST',
        body: submissionForm(q, modelCode, `${prefix}_missingWeight`),
        expectedStatus: 400,
      })
      await request('/submissions', {
        actor: a,
        method: 'POST',
        body: submissionForm(q, modelCode, `${prefix}_wrongWeight`, { contents: '{}', name: 'weights.pt' }),
        expectedStatus: 400,
      })
      return { missingWeights: 400, wrongExtension: 400 }
    },
  )
  await check(
    'model-real-inference',
    'Uploaded JSON weights are loaded in the isolated student worker',
    async () => {
      const result = await submit('modelValid', 'model', a, modelCode, {
        contents: '{"weight":2,"bias":1}',
        name: 'weights.json',
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.score, 100)
      assert.equal(result.hasWeights, true)
      return { submissionId: result.id, score: 100, hasWeights: true }
    },
  )
  await check(
    'model-invalid-payload',
    'Invalid parameter structure produces no score, preserving the prior best',
    async () => {
      need(submissions.modelValid, 'valid model submission')
      const result = await submit('modelInvalid', 'model', a, modelCode, {
        contents: '{}',
        name: 'weights.json',
      })
      assert.equal(result.score, null)
      assert.equal(result.status, 'failed')
      const hall = await request('/questions', { actor: need(a, 'A') })
      assert.equal(hall.find((q: Json) => q.id === questions.model.id)?.myScore, 100)
      return { submissionId: result.id, status: result.status, score: null, retainedBest: 100 }
    },
  )
  await check(
    'arena-empty-equality',
    'Attack exactly meeting the baseline qualifies; no opponent scores 100%',
    async () => {
      const result = await submit('attackFirst', 'attack', a, attackCode)
      assert.equal(result.status, 'completed')
      const score = await arenaScore('attack', a, 100, 0)
      assert.equal(score.qualified, true)
      assert.equal(score.emptyPool, true)
      assert.equal(score.counted, true)
      return { submissionId: result.id, score }
    },
  )
  await check(
    'arena-normal-loss',
    'A new strict defender turns the normal attack loss into counted 0%',
    async () => {
      need(submissions.attackFirst, 'first attack')
      const result = await submit('defenseFirst', 'defense', b, strictDefenseCode)
      assert.equal(result.status, 'completed')
      const defense = await arenaScore('defense', b, 100, 1)
      const attack = await arenaScore('attack', a, 0, 1)
      assert.equal(attack.successCount, 0)
      assert.equal(attack.counted, true)
      assert.equal(attack.emptyPool, false)
      return { submissionId: result.id, attack, defense }
    },
  )
  await check(
    'arena-attack-replacement',
    'A new qualified attack replaces the prior algorithm even at score 0',
    async () => {
      need(submissions.defenseFirst, 'first defense')
      const result = await submit('attackMixed', 'attack', a, mixedAttackCode)
      assert.equal(result.status, 'completed')
      const score = await arenaScore('attack', a, 0, 1)
      assert.equal(score.activeSubmissionId, result.id)
      return { submissionId: result.id, score }
    },
  )
  await check(
    'arena-dynamic-replacement',
    'Replacing an opponent recomputes both sides against the new frozen candidate',
    async () => {
      need(submissions.attackMixed, 'mixed attack')
      const result = await submit('defenseWeak', 'defense', b, weakDefenseCode)
      assert.equal(result.status, 'completed')
      const defense = await arenaScore('defense', b, 0, 1)
      const attack = await arenaScore('attack', a, 100, 1)
      assert.equal(defense.activeSubmissionId, result.id)
      assert.equal(defense.counted, true)
      return { submissionId: result.id, attack, defense }
    },
  )
  await check(
    'arena-baseline-rejection',
    'Below-baseline candidate has no score and cannot replace the active algorithm',
    async () => {
      const prior = need(submissions.attackMixed, 'active mixed attack')
      need(submissions.defenseWeak, 'weak defender')
      const result = await submit('attackRejected', 'attack', a, rejectedAttackCode)
      assert.equal(result.score, null)
      assert.equal(result.result?.qualified, false)
      const score = await arenaScore('attack', a, 100, 1)
      assert.equal(score.activeSubmissionId, prior.id)
      const board = await request(`/arena/questions/${questions.attack.id}/leaderboard`, {
        actor: need(a, 'A'),
      })
      assert.equal(board.filter((r: Json) => r.userId === a!.user.id).length, 1)
      return {
        rejectedSubmissionId: result.id,
        retainedSubmissionId: score.activeSubmissionId,
        score: score.score,
      }
    },
  )
  await check(
    'admin-student-arena',
    'Administrator detail shows current attack 100% and defense 0%, excluding both from basic totals',
    async () => {
      need(submissions.defenseWeak, 'replacement defender')
      const attackDetail = await request(`/admin/student-scores/${need(a, 'A').user.id}`, {
        actor: need(admin, 'admin'),
      })
      const defenseDetail = await request(`/admin/student-scores/${need(b, 'B').user.id}`, { actor: admin })
      const attack = attackDetail.questions.find((q: Json) => q.questionId === questions.attack.id)
      const defense = defenseDetail.questions.find((q: Json) => q.questionId === questions.defense.id)
      assert.equal(attack.score, 100)
      assert.equal(defense.score, 0)
      assert.equal(defense.state, 'scored')
      assert.equal(attack.scoreKind, 'current')
      assert.equal(attackDetail.student.basicTotalScore, 200)
      assert.equal(defenseDetail.student.basicTotalScore, 100)
      return { attack: attack.score, defense: defense.score, attackBasicTotal: 200, defenseBasicTotal: 100 }
    },
  )
  await check(
    'arena-error-preservation',
    'Student runtime error leaves the previous effective attack score intact',
    async () => {
      const prior = need(submissions.attackMixed, 'active mixed attack')
      const result = await submit(
        'attackError',
        'attack',
        a,
        'def attack():\n    raise RuntimeError("acceptance error")\n',
      )
      assert.equal(result.score, null)
      assert.ok(['error', 'student_error'].includes(result.status), `Unexpected status ${result.status}`)
      const score = await arenaScore('attack', a, 100, 1)
      assert.equal(score.activeSubmissionId, prior.id)
      return {
        errorSubmissionId: result.id,
        retainedSubmissionId: score.activeSubmissionId,
        score: score.score,
      }
    },
  )
  await check(
    'basic-version-reset',
    "Changing this run's basic question clears current scores but keeps submission history",
    async () => {
      const q = need(questions.basic, 'basic question')
      const historical = need(submissions.basicHigh, 'historical basic score')
      assert.ok(q.id.startsWith(`${prefix}_`))
      const beforeA = await request(`/users/${need(a, 'A').user.id}/stats`)
      const beforeB = await request(`/users/${need(b, 'B').user.id}/stats`)
      const changed = await request(`/admin/questions/${q.id}`, {
        actor: need(admin, 'admin'),
        method: 'PUT',
        body: { content: `${q.content}\nVersion-reset acceptance ${runId}.` },
      })
      assert.equal(changed.revision, q.revision + 1)
      const afterA = await request(`/users/${a!.user.id}/stats`)
      const afterB = await request(`/users/${b!.user.id}/stats`)
      assert.equal(afterA.totalScore, beforeA.totalScore - 100)
      assert.equal(afterB.totalScore, beforeB.totalScore - 100)
      const kept = await request(`/submissions/${historical.id}`, { actor: a })
      assert.equal(kept.score, 100)
      await request('/submissions', {
        actor: a,
        method: 'POST',
        body: submissionForm(q, sumCode, `${prefix}_oldVersion`),
        expectedStatus: 409,
      })
      questions.basic = changed
      return {
        previousVersion: q.revision,
        currentVersion: changed.revision,
        removedContribution: 100,
        historyScore: 100,
        staleVersionRejected: 409,
      }
    },
  )
  await check(
    'public-configuration',
    'Student question output hides package internals and retains separate attack/defense rows',
    async () => {
      const hall = await request('/questions', { actor: need(a, 'A') })
      for (const q of Object.values(questions)) {
        if (q.status !== 'published') continue
        const row = hall.find((r: Json) => r.id === q.id)
        assert.ok(row, `Missing published question ${q.id}`)
        assert.equal(row.definition.evaluation.packageId, undefined)
        assert.equal(row.definition.evaluation.baselineCode, undefined)
        assert.equal(row.definition.llm.poolId, undefined)
      }
      assert.equal(hall.find((r: Json) => r.id === questions.attack?.id)?.role, 'attack')
      assert.equal(hall.find((r: Json) => r.id === questions.defense?.id)?.role, 'defense')
      return { hiddenEvaluatorConfiguration: true, separateAttackDefenseRows: true }
    },
  )
  await check(
    'admin-student-version',
    'Administrator detail retains the old attempt while excluding its expired question score',
    async () => {
      const q = need(questions.basic, 'changed basic question')
      assert.ok(q.revision > 1, 'Version-reset case must succeed first')
      const detail = await request(`/admin/student-scores/${need(a, 'A').user.id}`, {
        actor: need(admin, 'admin'),
      })
      const row = detail.questions.find((r: Json) => r.questionId === q.id)
      assert.equal(row.questionVersion, q.revision)
      assert.equal(row.score, null)
      assert.equal(row.state, 'outdated')
      assert.equal(row.currentSubmissionCount, 0)
      assert.equal(row.submissionCount, 2)
      assert.equal(detail.student.basicTotalScore, 100)
      return { retainedHistory: row.submissionCount, currentScore: null, basicTotal: 100 }
    },
  )
  writeReport()
  console.log(
    JSON.stringify({
      report: reportPath,
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      skipped: cases.filter((c) => c.status === 'skipped').length,
    }),
  )
  if (cases.some((c) => c.status !== 'passed')) process.exitCode = 1
}
main().catch((error) => {
  console.error(redact(error))
  process.exitCode = 1
})
