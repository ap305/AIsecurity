import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTestDatabase } from './database.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import type { Prisma } from '@prisma/client'

let db: Awaited<ReturnType<typeof createTestDatabase>>,
  prisma: (typeof import('../src/lib/db.js'))['prisma'],
  questionService: typeof import('../src/services/questions.js')
let packageId: string, digest: string
const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = path.join(serviceRoot, '../../.test-artifacts', `question-publish-${crypto.randomUUID()}`)
before(async () => {
  process.env.EVALUATION_PACKAGE_ROOT = testRoot
  db = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  questionService = await import('../src/services/questions.js')
  const packages = await import('../src/lib/evaluationPackage.js')
  const p = await packages.importEvaluationDirectory(
    path.join(serviceRoot, 'evaluation-examples/basic-algorithm'),
  )
  packageId = p.id
  digest = p.digest
  await prisma.user.create({
    data: { id: 'learner', username: 'learner', displayName: 'learner', password: 'unused' },
  })
})
after(async () => {
  await prisma?.$disconnect()
  await db?.close()
  if (testRoot.startsWith(path.resolve(serviceRoot, '../../.test-artifacts') + path.sep))
    fs.rmSync(testRoot, { recursive: true, force: true })
})
function body() {
  return {
    title: '算法题',
    content: '原始题面',
    type: 'code',
    category: 'basic',
    definition: { evaluation: { packageId } },
  }
}
test('first publish requires a digest-matching successful self-test and starts at version 1', async () => {
  await questionService.saveQuestion('published', body(), 'admin', true)
  await assert.rejects(
    () => questionService.saveQuestion('published', { status: 'published' }, 'admin'),
    /自测/,
  )
  // External Compose execution has its own runner tests; this fixture exercises the publication evidence contract.
  const dir = path.join(testRoot, packageId, '_self-tests')
  fs.mkdirSync(dir, { recursive: true })
  const id = crypto.randomUUID()
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      packageId,
      packageDigest: digest,
      configurationKey: selfTestConfigurationKey(normalizeDefinition(body().definition), null, 'basic'),
      phase: 'basic',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed',
      result: { status: 'completed', cleanupStatus: 'cleaned', score: 100, maxScore: 100 },
    }),
  )
  const published = await questionService.saveQuestion('published', { status: 'published' }, 'admin')
  assert.equal(published.revision, 1)
  assert.equal(await prisma.questionRevision.count(), 1)
})
test('unchanged re-save does not increment revision; changed basic content atomically clears current scores', async () => {
  const unchanged = await questionService.saveQuestion('published', { status: 'published' }, 'admin')
  assert.equal(unchanged.revision, 1)
  const { recordBasicResult } = await import('../src/services/basicScores.js')
  await prisma.submission.create({
    data: {
      id: 'best',
      questionId: 'published',
      userId: 'learner',
      code: 'solve',
      status: 'judging',
      questionVersion: 1,
    },
  })
  await recordBasicResult('best', 85, {})
  const changed = await questionService.saveQuestion('published', { content: '新的题面' }, 'admin')
  assert.equal(changed.revision, 2)
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).totalScore, 0)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'best' } })).score, 85)
  const zeroAt = (await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).scoreReachedAt
  await questionService.saveQuestion('published', { content: '又一次改变' }, 'admin')
  assert.equal(
    (await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).scoreReachedAt.getTime(),
    zeroAt.getTime(),
  )
})
test('published API binding remains unchanged when global default/pool gets a new revision', async () => {
  const { savePool, freezePoolBinding } = await import('../src/services/apiPool.js')
  const p = await savePool(
    null,
    {
      name: '模型A',
      kind: 'llm',
      model: 'qwen3-8b',
      modelVersion: 'r1',
      baseUrl: 'http://127.0.0.1:8000/v1',
      enabled: true,
      isDefault: true,
      parameters: { temperature: 0 },
    },
    'admin',
  )
  const frozen = await freezePoolBinding(p.id, 'llm')
  await savePool(p.id, { model: 'qwen3-32b', modelVersion: 'r2' }, 'admin')
  assert.equal(frozen.model, 'qwen3-8b')
  assert.equal(frozen.revision, 1)
  assert.equal((await freezePoolBinding(p.id, 'llm')).model, 'qwen3-32b')
  assert.equal(await prisma.apiPoolRevision.count({ where: { poolId: p.id } }), 2)
})
test('declared blank regions reject edits to frozen scaffolding', async () => {
  const { validateCodeBlanks } = await import('../src/lib/codeBlanks.js')
  const template = 'import math\n# BEGIN STUDENT\npass\n# END STUDENT\nfixed = 1\n'
  validateCodeBlanks(template, template.replace('pass', 'answer = 7'))
  assert.throws(() => validateCodeBlanks(template, template.replace('fixed = 1', 'fixed = 2')))
})
test('a changed evaluation configuration cannot reuse earlier successful publication evidence', async () => {
  await assert.rejects(
    () =>
      questionService.saveQuestion(
        'published',
        { definition: { evaluation: { packageId, repetitions: 2 } } },
        'admin',
      ),
    /自测/,
  )
  assert.equal((await prisma.question.findUniqueOrThrow({ where: { id: 'published' } })).revision, 3)
})
test('attack self-tests cannot authorize defense; baseline evidence must meet the configured metric', async () => {
  const packages = await import('../src/lib/evaluationPackage.js')
  const p = await packages.importEvaluationDirectory(
    path.join(serviceRoot, 'evaluation-examples/attack-defense'),
  )
  const definition = normalizeDefinition({ evaluation: { packageId: p.id, baselineThreshold: 0.5 } })
  const draft = { ...body(), category: 'adversarial', scenarioId: 'proof-arena', role: 'defense', definition }
  await questionService.saveQuestion('proof-defense', draft, 'admin', true)
  const dir = path.join(testRoot, p.id, '_self-tests')
  fs.mkdirSync(dir, { recursive: true })
  let evidenceTime = Date.now()
  const evidence = (role: string, baselineMetric: number) => {
    const completedAt = new Date((evidenceTime += 1000)).toISOString()
    for (const phase of ['baseline', 'opponent']) {
      const id = crypto.randomUUID()
      fs.writeFileSync(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          packageId: p.id,
          packageDigest: p.digest,
          configurationKey: selfTestConfigurationKey(definition, role, 'adversarial'),
          phase,
          createdAt: completedAt,
          completedAt,
          status: 'completed',
          result: {
            status: 'completed',
            cleanupStatus: 'cleaned',
            metrics: { qualificationMetric: baselineMetric, successMetric: 0 },
          },
        }),
      )
    }
  }
  evidence('attack', 1)
  await assert.rejects(
    () => questionService.saveQuestion('proof-defense', { status: 'published' }, 'admin'),
    /自测/,
  )
  evidence('defense', 0.49)
  await assert.rejects(
    () => questionService.saveQuestion('proof-defense', { status: 'published' }, 'admin'),
    /基线/,
  )
  evidence('defense', 0.5)
  const published = await questionService.saveQuestion('proof-defense', { status: 'published' }, 'admin')
  assert.equal(published.status, 'published')
})

async function createSnapshotlessQuestion(id: string, overrides: Partial<Prisma.QuestionCreateInput> = {}) {
  return prisma.question.create({
    data: {
      id,
      moduleCode: 'LEGACY',
      number: 1,
      title: '旧题目',
      content: '旧题面',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      status: 'draft',
      ...overrides,
    },
  })
}

test('snapshotless legacy evidence survives repeated draft saves that replace the old configuration', async (t) => {
  const cases: {
    name: string
    overrides?: Partial<Prisma.QuestionCreateInput>
    prepare?: (id: string) => Promise<unknown>
  }[] = [
    { name: 'published', overrides: { status: 'published' } },
    { name: 'old-test-config', overrides: { testConfig: JSON.stringify({ type: 'code_eval' }) } },
    { name: 'old-definition', overrides: { definition: JSON.stringify({ evaluation: { version: 'old' } }) } },
    { name: 'judge-version', overrides: { judgeVersion: 'old-judge-r1' } },
    {
      name: 'test-cases',
      prepare: (questionId) =>
        prisma.testCase.create({ data: { questionId, name: '旧测试', type: 'code', config: '{}' } }),
    },
    {
      name: 'published-history',
      prepare: (targetId) =>
        prisma.auditEvent.create({
          data: { actorId: 'admin', action: 'question.publish', targetId, detail: '{"revision":1}' },
        }),
    },
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const id = `legacy-${item.name}`
      await createSnapshotlessQuestion(id, item.overrides)
      await item.prepare?.(id)
      const draft = await questionService.saveQuestion(
        id,
        { ...body(), status: 'draft', testConfig: null },
        'admin',
      )
      assert.equal(draft.revision, 1)
      assert.equal(await prisma.questionRevision.count({ where: { questionId: id } }), 0)
      await questionService.saveQuestion(id, { title: '新版草稿' }, 'admin')
      const published = await questionService.saveQuestion(id, { status: 'published' }, 'admin')
      assert.equal(published.revision, 2)
      assert.equal(await prisma.questionRevision.count({ where: { questionId: id, revision: 1 } }), 0)
      assert.equal(await prisma.questionRevision.count({ where: { questionId: id, revision: 2 } }), 1)
      assert.equal((await questionService.saveQuestion(id, { status: 'published' }, 'admin')).revision, 2)
      assert.equal(
        await prisma.auditEvent.count({ where: { targetId: id, action: 'question.legacy_revision' } }),
        1,
      )
    })
  }
})

test('legacy score history forces a new revision and prevents late old results from restoring scores', async () => {
  const id = 'legacy-score-history'
  await createSnapshotlessQuestion(id)
  const { recordBasicResult } = await import('../src/services/basicScores.js')
  await prisma.submission.createMany({
    data: ['old-best', 'old-late'].map((submissionId) => ({
      id: submissionId,
      questionId: id,
      userId: 'learner',
      code: 'old solve',
      status: 'judging',
      questionVersion: 1,
    })),
  })
  await recordBasicResult('old-best', 85, {})
  await questionService.saveQuestion(id, { ...body(), status: 'draft' }, 'admin')
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).totalScore, 85)
  const published = await questionService.saveQuestion(id, { status: 'published' }, 'admin')
  assert.equal(published.revision, 2)
  assert.equal(await prisma.basicScore.count({ where: { questionId: id } }), 0)
  const total = await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })
  assert.equal(total.totalScore, 0)
  assert.equal(total.tasksCompleted, 0)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'old-best' } })).score, 85)
  assert.equal(await recordBasicResult('old-late', 99, {}), false)
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).totalScore, 0)
})

test('snapshotless basic ledger alone is sufficient history for migration publication', async () => {
  const id = 'legacy-ledger-only'
  await createSnapshotlessQuestion(id)
  await prisma.basicScore.create({
    data: {
      questionId: id,
      userId: 'learner',
      questionVersion: 1,
      score: 25,
      submissionId: 'retired-source',
    },
  })
  await prisma.basicTotal.update({
    where: { userId: 'learner' },
    data: { totalScore: 25, tasksCompleted: 1 },
  })
  const published = await questionService.saveQuestion(id, { ...body(), status: 'published' }, 'admin')
  assert.equal(published.revision, 2)
  assert.equal(await prisma.basicScore.count({ where: { questionId: id } }), 0)
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'learner' } })).totalScore, 0)
})

test('new drafts and creation records from the earlier service still first publish at revision 1', async () => {
  for (const earlierRecord of [false, true]) {
    const id = earlierRecord ? 'new-draft-earlier-audit' : 'new-draft-current-audit'
    await questionService.saveQuestion(id, body(), 'admin', true)
    if (earlierRecord) {
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: id } })
      await prisma.auditEvent.update({
        where: { id: event.id },
        data: { detail: JSON.stringify({ revision: 1, status: 'draft' }) },
      })
    }
    await questionService.saveQuestion(id, { title: '首次发布前修改', testConfig: {} }, 'admin')
    await questionService.saveQuestion(id, { ...body(), testConfig: null }, 'admin')
    const published = await questionService.saveQuestion(id, { status: 'published' }, 'admin')
    assert.equal(published.revision, 1)
    assert.equal(
      await prisma.auditEvent.count({ where: { targetId: id, action: 'question.legacy_revision' } }),
      0,
    )
  }
})


test('a supplied question digest rejects edits committed between client GET and save',async()=>{
 const created=await questionService.saveQuestion('cas-client-window',body(),'admin',true)
 const {questionUpdateDigest}=await import('../src/lib/questionUpdatePrecondition.js')
 const expected=questionUpdateDigest(JSON.parse(JSON.stringify(created)))
 await questionService.saveQuestion('cas-client-window',{content:'teacher edit'},'admin')
 const before=await prisma.question.findUniqueOrThrow({where:{id:'cas-client-window'}}),audit=await prisma.auditEvent.count()
 await assert.rejects(questionService.saveQuestion('cas-client-window',{content:'stale client overwrite',expectedQuestionDigest:expected},'admin'),(e:any)=>e.status===409)
 assert.deepEqual(await prisma.question.findUniqueOrThrow({where:{id:'cas-client-window'}}),before)
 assert.equal(await prisma.auditEvent.count(),audit)
 const current=questionService.questionView(before,true)
 const saved=await questionService.saveQuestion('cas-client-window',{content:'fresh conditional edit',expectedQuestionDigest:questionUpdateDigest(current)},'admin')
 assert.equal(saved.content,'fresh conditional edit')
})
test('question digest is rechecked inside the serializable transaction even at the same timestamp',async t=>{
 const q=await questionService.saveQuestion('cas-transaction-window',body(),'admin',true)
 const {questionUpdateDigest}=await import('../src/lib/questionUpdatePrecondition.js');const expected=questionUpdateDigest(q)
 const original=prisma.$transaction.bind(prisma);let edited=false
 t.mock.method(prisma,'$transaction',async(work:any,options:any)=>{
  if(!edited){edited=true;await prisma.question.update({where:{id:q.id},data:{content:'transaction-time teacher edit',updatedAt:q.updatedAt}})}
  return original(work,options)
 })
 await assert.rejects(questionService.saveQuestion(q.id,{content:'stale overwrite',expectedQuestionDigest:expected},'admin'),(e:any)=>e.status===409)
 assert.equal((await prisma.question.findUniqueOrThrow({where:{id:q.id}})).content,'transaction-time teacher edit')
})
