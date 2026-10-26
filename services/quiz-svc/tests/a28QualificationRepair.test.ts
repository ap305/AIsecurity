import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { planA28QualificationRepair, auditedPackageFileChanges, repairA28RuntimeSource, A28_UNPROTECTED_BASELINE_BRANCH } from '../src/services/a28QualificationRepair.js'

const OLD_PACKAGE = '38fdcf16-de9a-4bac-9dab-754bed46c886'
const OLD_DIGEST = '7b2409595beebbee49cd043dd782ef295f42b1be9c8d3899b2568fd291bc2490'
const OLD_RUNTIME = 'bf497fcf3f345bf7a0fffc64f0a360e76d09da1593ae7f4979068277e6331bfe'
const VERSION = 'v3-api-citation-queue-20261016-v8'
const replacement = { id: '4cb99f0c-d7cd-493b-9ea6-e8121a6fd4cf', digest: 'b'.repeat(64), valid: true as const }
function inputs() {
  const definition = { kind: 'agent', weights: { enabled: false, required: false }, teacherApi: { enabled: false },
    llm: { enabled: true, poolId: 'unchanged-pool' }, evaluation: { version: VERSION, packageId: OLD_PACKAGE,
      packageDigest: OLD_DIGEST, baselineMetric: 'qualificationMetric', baselineThreshold: 60,
      successMetric: 'successMetric', successThreshold: 0.0333, timeoutMs: 3600000,
      repetitions: 1, seed: 42, number: '28', role: 'attack', samples: 30, budget: 20 } }
  const question = { id: 'V3-261012-A28', category: 'adversarial', role: 'attack', scenarioId: 'V3-261012-28',
    status: 'published', revision: 2, evaluationVersion: VERSION, title: 'RAG知识库窃取（攻击）',
    content: '原题内容', answerTemplate: 'class EnumerativeCitationProbe: pass', type: 'code', difficulty: 'L2',
    definition: JSON.stringify(definition) }
  const frozen = { questionId: question.id, questionVersion: 2, category: question.category, role: question.role,
    scenarioId: question.scenarioId, evaluationVersion: VERSION, title: question.title, content: question.content,
    answerTemplate: question.answerTemplate, type: question.type, difficulty: question.difficulty, definition,
    modelBinding: { poolId: 'unchanged-pool', revision: 5, model: 'unchanged-model', parameters: { temperature: 0 } },
    extraFrozenEvidence: { retained: true } }
  return { question, frozen }
}
test('A28 repair changes only the allowed definition fields and creates revision 3 without mutating inputs', () => {
  const { question, frozen } = inputs(); const original = structuredClone({ question, frozen, replacement })
  const plan = planA28QualificationRepair(question, frozen, replacement)
  assert.deepEqual({ question, frozen, replacement }, original)
  assert.equal(plan.previousRevision, 2); assert.equal(plan.nextRevision, 3)
  assert.equal(plan.questionData.revision, 3); assert.equal(plan.questionData.evaluationVersion, VERSION)
  const updated = JSON.parse(plan.questionData.definition)
  const expected = structuredClone(frozen.definition)
  Object.assign(expected.evaluation, { packageId: replacement.id, packageDigest: replacement.digest, baselineThreshold: 40 })
  assert.deepEqual(updated, expected)
  assert.match(plan.questionData.content, /无防御/); assert.match(plan.questionData.content, /40%/)
  assert.deepEqual(plan.newSnapshot, { ...frozen, questionVersion: 3, content: plan.questionData.content, definition: expected })
})
test('string snapshot input preserves binding, template and non-evaluation fields', () => {
  const { question, frozen } = inputs()
  const plan = planA28QualificationRepair(question, JSON.stringify(frozen), replacement)
  assert.deepEqual(plan.newSnapshot.modelBinding, frozen.modelBinding)
  assert.equal(plan.newSnapshot.answerTemplate, frozen.answerTemplate)
  assert.equal(plan.newSnapshot.definition.evaluation.successThreshold, 0.0333)
})
test('repair rejects another question, role, scenario, revision or evaluation version', () => {
  for (const [field, value] of Object.entries({ id: 'V3-261012-D28', role: 'defense', scenarioId: 'other', revision: 3,
    evaluationVersion: 'v10', status: 'draft', category: 'basic' })) {
    const { question, frozen } = inputs()
    assert.throws(() => planA28QualificationRepair({ ...question, [field]: value }, frozen, replacement))
  }
})
test('repair requires exact audited old package, threshold, metric and synchronized frozen snapshot', () => {
  for (const [field, value] of Object.entries({ packageId: 'other', packageDigest: 'c'.repeat(64), baselineThreshold: 40,
    baselineMetric: 'attackMetric', version: 'v10' })) {
    const { question, frozen } = inputs(); const changed = structuredClone(frozen.definition)
    Object.assign(changed.evaluation, { [field]: value }); question.definition = JSON.stringify(changed); frozen.definition = changed
    assert.throws(() => planA28QualificationRepair(question, frozen, replacement))
  }
  for (const field of ['questionId', 'questionVersion', 'role', 'scenarioId', 'evaluationVersion', 'title', 'content', 'answerTemplate', 'type', 'difficulty']) {
    const { question, frozen } = inputs()
    assert.throws(() => planA28QualificationRepair(question, { ...frozen, [field]: 'different' }, replacement))
  }
  const { question, frozen } = inputs(); frozen.definition.llm.poolId = 'changed-pool'
  assert.throws(() => planA28QualificationRepair(question, frozen, replacement))
})
test('new package must be valid, different and carry a valid digest', () => {
  const { question, frozen } = inputs()
  for (const candidate of [{ ...replacement, valid: false }, { ...replacement, id: OLD_PACKAGE },
    { ...replacement, digest: OLD_DIGEST }, { ...replacement, digest: 'not-a-hash' }, { ...replacement, id: '' }]) {
    assert.throws(() => planA28QualificationRepair(question, frozen, candidate))
  }
})
test('file audit accepts only the exact old runtime hash and one changed runtime file', () => {
  const oldFiles = { 'class_runtime.py': OLD_RUNTIME, 'course/test.py': 'a'.repeat(64), 'public/bootstrap.py': 'c'.repeat(64) }
  const newFiles = { ...oldFiles, 'class_runtime.py': 'b'.repeat(64) }
  assert.deepEqual(auditedPackageFileChanges(oldFiles, newFiles), { changedFiles: ['class_runtime.py'], oldRuntimeSha256: OLD_RUNTIME,
    newRuntimeSha256: 'b'.repeat(64), unchangedFileCount: 2 })
  for (const files of [{ ...newFiles, 'course/test.py': 'd'.repeat(64) }, { ...newFiles, 'extra.py': 'e'.repeat(64) },
    { 'class_runtime.py': 'b'.repeat(64) }, oldFiles]) assert.throws(() => auditedPackageFileChanges(oldFiles, files))
  assert.throws(() => auditedPackageFileChanges({ ...oldFiles, 'class_runtime.py': 'f'.repeat(64) }, newFiles))
})

test('runtime repair inserts only the audited A28 branch into the exact original package bytes', () => {
  const original = fs.readFileSync(new URL('./fixtures/a28-original-class-runtime.py', import.meta.url), 'utf8')
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), OLD_RUNTIME)
  const currentSharedSource = fs.readFileSync(new URL('../course-pack-v3/adversarial/class_runtime.py', import.meta.url), 'utf8')
  const repaired = repairA28RuntimeSource(original, currentSharedSource)
  assert.notEqual(repaired, original)
  assert.equal(repaired.replace(A28_UNPROTECTED_BASELINE_BRANCH, ''), original)
  assert.equal(repaired.split(A28_UNPROTECTED_BASELINE_BRANCH).length - 1, 1)
  // Later shared A03/A27 code must not leak into the immutable A28 package.
  const unrelatedChanges = currentSharedSource.replace('import copy', 'import copy\n# unrelated shared runtime change')
  assert.equal(repairA28RuntimeSource(original, unrelatedChanges), repaired)
})

test('runtime repair refuses changed original bytes or a candidate with a different/missing branch', () => {
  const original = fs.readFileSync(new URL('./fixtures/a28-original-class-runtime.py', import.meta.url), 'utf8')
  const candidate = fs.readFileSync(new URL('../course-pack-v3/adversarial/class_runtime.py', import.meta.url), 'utf8')
  assert.throws(() => repairA28RuntimeSource(original + '\n', candidate), /运行时/)
  assert.throws(() => repairA28RuntimeSource(original, original), /分支/)
  assert.throws(() => repairA28RuntimeSource(original, candidate.replace('coverage >= course.QUALIFY_COVERAGE', 'coverage > course.QUALIFY_COVERAGE')), /分支/)
  assert.throws(() => repairA28RuntimeSource(original, candidate.replace('        return row\n    reference_name', '        return row\n        raise RuntimeError()\n    reference_name')), /分支/)
  assert.throws(() => repairA28RuntimeSource(original, candidate + '\n' + candidate), /入口/)
})
