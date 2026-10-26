import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './database.js'

test('A28 repair refuses live submissions and preserves D28 opponents and all previous student records', async () => {
  const database = await createTestDatabase()
  const { prisma } = await import('../src/lib/db.js')
  try {
    const { publishA28QualificationRepair } = await import('../src/services/a28QualificationPublication.js')
    const version = 'v3-api-citation-queue-20261016-v8', scenarioId = 'V3-261012-28', qid = 'V3-261012-A28'
    const definition = { kind: 'agent', evaluation: { version, packageId: '38fdcf16-de9a-4bac-9dab-754bed46c886', packageDigest: '7b2409595beebbee49cd043dd782ef295f42b1be9c8d3899b2568fd291bc2490', baselineMetric: 'qualificationMetric', baselineThreshold: 60, successMetric: 'successMetric', successThreshold: .0333 } }
    for (const [id,role] of [[qid,'attack'],['V3-261012-D28','defense']])
      await prisma.question.create({ data: { id, role, scenarioId, evaluationVersion: version, revision: 2, moduleCode: 'API', number: 28, title: id, content: '原题', answerTemplate: 'template', type: 'code', difficulty: 'L2', category: 'adversarial', definition: JSON.stringify(definition) } })
    const frozen = { questionId: qid, questionVersion: 2, category: 'adversarial', role: 'attack', scenarioId, evaluationVersion: version, title: qid, content: '原题', answerTemplate: 'template', type: 'code', difficulty: 'L2', definition, modelBinding: { model: 'unchanged' } }
    await prisma.questionRevision.create({ data: { questionId: qid, revision: 2, snapshot: JSON.stringify(frozen) } })
    for (const [id,questionId,role,status] of [['old-failed',qid,'attack','baseline_failed'],['d28-valid','V3-261012-D28','defense','completed']])
      await prisma.submission.create({ data: { id, questionId, userId: id, code: 'original-private', status, score: role === 'defense' ? 100 : null, questionVersion: 2, category: 'adversarial', role, scenarioId, evaluationVersion: version, configSnapshot: JSON.stringify(frozen) } })
    await prisma.arenaAlgorithm.create({ data: { id: 'defender', submissionId: 'd28-valid', questionId: 'V3-261012-D28', userId: 'd28-valid', scenarioId, role: 'defense', evaluationVersion: version, status: 'active' } })
    await prisma.arenaSlot.create({ data: { algorithmId: 'defender', userId: 'd28-valid', scenarioId, role: 'defense', evaluationVersion: version } })
    await prisma.arenaScore.create({ data: { algorithmId: 'defender', userId: 'd28-valid', questionId: 'V3-261012-D28', scenarioId, role: 'defense', evaluationVersion: version, score: 100, successCount: 0, opponentCount: 0, snapshotRevision: 1, snapshotId: 'old-round', achievedAt: new Date() } })
    const replacement = { id: '9aaa9999-aaaa-4999-b999-aaaaaaaaaaaa', digest: 'b'.repeat(64), valid: true as const }
    const evidence = { sourceCommit: 'a'.repeat(40), packageFileAudit: { changedFiles: ['class_runtime.py'], oldRuntimeSha256: 'bf497fcf3f345bf7a0fffc64f0a360e76d09da1593ae7f4979068277e6331bfe', newRuntimeSha256: 'c'.repeat(64) } }
    const records = async () => ({ submissions: await prisma.submission.findMany({ orderBy: { id: 'asc' } }), slots: await prisma.arenaSlot.findMany(), scores: await prisma.arenaScore.findMany(), algorithms: await prisma.arenaAlgorithm.findMany(), defender: await prisma.question.findUnique({ where: { id: 'V3-261012-D28' } }) })
    const before = await records()
    await prisma.evaluationTask.create({ data: { id: 'live', submissionId: 'd28-valid', state: 'running' } })
    await assert.rejects(publishA28QualificationRepair(prisma, replacement, evidence), /活动评测/)
    await prisma.evaluationTask.delete({ where: { id: 'live' } })
    await prisma.evaluationTask.create({ data: { id: 'queued-inconsistent', submissionId: 'old-failed', state: 'queued' } })
    await assert.rejects(publishA28QualificationRepair(prisma, replacement, evidence), /活动材料|有效成绩/)
    await prisma.evaluationTask.delete({ where: { id: 'queued-inconsistent' } })
    await prisma.submission.update({ where: { id: 'old-failed' }, data: { status: 'queued' } })
    await assert.rejects(publishA28QualificationRepair(prisma, replacement, evidence), /活动材料|有效成绩/)
    const old = before.submissions.find(s => s.id === 'old-failed')!
    await prisma.submission.update({ where: { id: old.id }, data: { status: old.status, updatedAt: old.updatedAt } })
    await assert.rejects(publishA28QualificationRepair(prisma, replacement, { ...evidence, sourceCommit: 'bad' }), /证据/)
    const result = await publishA28QualificationRepair(prisma, replacement, evidence)
    assert.equal(result.revision, 3); assert.equal(result.baselineThreshold, 40)
    assert.deepEqual(await records(), before)
    assert.deepEqual(JSON.parse((await prisma.questionRevision.findUniqueOrThrow({ where: { questionId_revision: { questionId: qid, revision: 2 } } })).snapshot), frozen)
    const updated = await prisma.question.findUniqueOrThrow({ where: { id: qid } })
    assert.equal(JSON.parse(updated.definition).evaluation.baselineThreshold, 40); assert.equal(updated.evaluationVersion, version)
    const audit = await prisma.auditEvent.findMany({ where: { targetId: qid } })
    assert.equal(audit.length, 1); assert.equal(JSON.parse(audit[0].detail!).existingStudentRecordsChanged, 0)
    await assert.rejects(publishA28QualificationRepair(prisma, replacement, evidence), /revision2/)
    assert.equal(await prisma.questionRevision.count(), 2)
  } finally { await prisma.$disconnect(); await database.close() }
})
