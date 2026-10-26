import type { PrismaClient } from '@prisma/client'
import { planA28QualificationRepair, A28_QUALIFICATION_REPAIR } from './a28QualificationRepair.js'

/** Explicit maintenance exception for the audited A28 qualification defect. */
export async function publishA28QualificationRepair(
  db: PrismaClient,
  replacement: { id: string; digest: string; valid: true },
  evidence: { sourceCommit: string; packageFileAudit: { changedFiles: string[]; oldRuntimeSha256: string; newRuntimeSha256: string } },
) {
  if (!/^[0-9a-f]{40}$/.test(evidence.sourceCommit) ||
      JSON.stringify(evidence.packageFileAudit.changedFiles) !== '["class_runtime.py"]' ||
      evidence.packageFileAudit.oldRuntimeSha256 !== A28_QUALIFICATION_REPAIR.oldRuntimeSha256 ||
      !/^[0-9a-f]{64}$/.test(evidence.packageFileAudit.newRuntimeSha256))
    throw new Error('A28 修复证据不完整')
  return db.$transaction(async (tx) => {
    // These locks exclude concurrent queue claims and a just-accepted submission.
    // They last only for the small metadata transaction; no evaluation is run here.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout='1500ms'`)
    await tx.$executeRawUnsafe(`LOCK TABLE "Question","QuestionRevision","Submission","EvaluationTask","ArenaEvaluation","ArenaAlgorithm","ArenaSlot","ArenaScore" IN SHARE ROW EXCLUSIVE MODE`)
    const questionId = A28_QUALIFICATION_REPAIR.questionId
    const question = await tx.question.findUniqueOrThrow({ where: { id: questionId } })
    const frozen = await tx.questionRevision.findUniqueOrThrow({ where: { questionId_revision: { questionId, revision: 2 } } })
    const plan = planA28QualificationRepair(question, frozen.snapshot, replacement)
    if (await tx.evaluationTask.count({ where: { state: 'running' } }) ||
        await tx.arenaEvaluation.count({ where: { status: 'running' } }))
      throw new Error('存在活动评测，稍后在空闲窗口重试发布')
    const submissionIds = (await tx.submission.findMany({ where: { questionId }, select: { id: true } })).map(s => s.id)
    if (await tx.evaluationTask.count({ where: { submissionId: { in: submissionIds }, state: { in: ['queued','running'] } } }) ||
        await tx.arenaEvaluation.count({ where: { submissionId: { in: submissionIds }, status: { in: ['queued','running'] } } }) ||
        await tx.submission.count({ where: { questionId, status: { in: ['queued','pending','judging','baseline','opponents'] } } }) ||
        await tx.arenaAlgorithm.count({ where: { questionId, status: { in: ['active','candidate'] } } }) ||
        await tx.arenaScore.count({ where: { questionId } }) ||
        await tx.arenaSlot.count({ where: { scenarioId: question.scenarioId!, role: 'attack', evaluationVersion: question.evaluationVersion } }) ||
        await tx.submission.count({ where: { questionId, status: 'completed' } }))
      throw new Error('A28 已有活动材料或有效成绩，需要重新审查发布方案')
    const changed = await tx.question.updateMany({ where: { id: questionId, revision: 2, updatedAt: question.updatedAt }, data: plan.questionData })
    if (changed.count !== 1) throw new Error('A28 题目并发修改，修复未发布')
    await tx.questionRevision.create({ data: { questionId, revision: 3, snapshot: JSON.stringify(plan.newSnapshot) } })
    await tx.auditEvent.create({ data: {
      actorId: 'maintenance:authorized-a28-repair', action: 'maintenance.a28.unprotected-qualification-repair', targetId: questionId,
      detail: JSON.stringify({ previousRevision: 2, revision: 3, oldThreshold: 60, newThreshold: 40,
        oldPackageId: A28_QUALIFICATION_REPAIR.oldPackageId, newPackageId: replacement.id,
        newPackageDigest: replacement.digest, ...evidence, existingStudentRecordsChanged: 0 }),
    } })
    return { questionId, revision: 3, baselineThreshold: 40, packageId: replacement.id,
      evaluationVersion: question.evaluationVersion, existingStudentRecordsChanged: 0 }
  }, { isolationLevel: 'Serializable', maxWait: 3000, timeout: 10000 })
}
