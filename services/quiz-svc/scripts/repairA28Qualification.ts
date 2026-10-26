/** Explicit, audited A28-only repair. No HTTP credentials or model calls. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../src/lib/db.js'
import { EVALUATION_PACKAGE_ROOT, readEvaluationPackage, importEvaluationDirectory } from '../src/lib/evaluationPackage.js'
import { A28_QUALIFICATION_REPAIR as fixed, auditedPackageFileChanges, planA28QualificationRepair, repairA28RuntimeSource } from '../src/services/a28QualificationRepair.js'
import { publishA28QualificationRepair } from '../src/services/a28QualificationPublication.js'

const root = process.env.A28_REPAIR_WORK_ROOT!
assert(root?.startsWith('/home/zl/ai-security-v3-20261016/state/a28-'))
const mode = process.argv[2] ?? 'plan'
assert(['plan','prepare','publish'].includes(mode))
const sourceCommit = process.env.A28_REPAIR_SOURCE_COMMIT!
assert.match(sourceCommit, /^[0-9a-f]{40}$/)
const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex')
const writePrivate = (name: string, data: unknown) => fs.writeFileSync(path.join(root,name),JSON.stringify(data,null,2),{mode:0o600,flag:'wx'})
try {
  const original = await readEvaluationPackage(fixed.oldPackageId)
  assert.equal(original.digest,fixed.oldPackageDigest)
  const oldRoot = path.join(EVALUATION_PACKAGE_ROOT,original.id)
  const oldMetadata = JSON.parse(fs.readFileSync(path.join(oldRoot,'_metadata.json'),'utf8'))
  if (mode === 'prepare') {
    assert(!fs.existsSync(root),'Use a fresh private work directory')
    fs.mkdirSync(root,{mode:0o700})
    const source = path.join(root,'source');fs.mkdirSync(source)
    for (const name of Object.keys(oldMetadata.files)) {
      const target = path.join(source,name);fs.mkdirSync(path.dirname(target),{recursive:true})
      fs.writeFileSync(target,fs.readFileSync(path.join(oldRoot,name)))
    }
    const runtimePath = path.resolve('course-pack-v3/adversarial/class_runtime.py')
    fs.writeFileSync(path.join(source,'class_runtime.py'),repairA28RuntimeSource(
      fs.readFileSync(path.join(oldRoot,'class_runtime.py'),'utf8'),fs.readFileSync(runtimePath,'utf8')))
    const candidateFiles = Object.fromEntries(Object.keys(oldMetadata.files).map(name=>[name,sha(fs.readFileSync(path.join(source,name)))]))
    const packageFileAudit = auditedPackageFileChanges(oldMetadata.files,candidateFiles)
    const descriptor = await importEvaluationDirectory(source)
    const question = await prisma.question.findUniqueOrThrow({where:{id:fixed.questionId}})
    const previous = await prisma.questionRevision.findUniqueOrThrow({where:{questionId_revision:{questionId:fixed.questionId,revision:2}}})
    const plan = planA28QualificationRepair(question,previous.snapshot,descriptor)
    const defender = await prisma.arenaAlgorithm.findFirstOrThrow({where:{questionId:'V3-261012-D28',status:'active'},orderBy:{createdAt:'asc'}})
    const defenseSubmission = await prisma.submission.findUniqueOrThrow({where:{id:defender.submissionId}})
    assert.equal(defenseSubmission.status,'completed');assert.equal(defenseSubmission.evaluationVersion,fixed.evaluationVersion)
    const defenseQuestion = await prisma.question.findUniqueOrThrow({where:{id:'V3-261012-D28'}})
    assert.equal(defenseQuestion.revision,defenseSubmission.questionVersion)
    const snapshot = plan.newSnapshot
    const fixture = {packageId:descriptor.id,packageDigest:descriptor.digest,questionVersion:3,
      evaluationVersion:fixed.evaluationVersion,parameters:snapshot.definition.evaluation,
      answerTemplate:snapshot.answerTemplate,referenceCode:fs.readFileSync(path.join(oldRoot,'course/attack.py'),'utf8'),
      opponent:{submissionId:defenseSubmission.id,code:defenseSubmission.code,filePath:null,
        questionVersion:defenseSubmission.questionVersion,evaluationVersion:defenseSubmission.evaluationVersion}}
    const smokePackages=path.join(root,'packages');fs.mkdirSync(smokePackages)
    fs.cpSync(path.join(EVALUATION_PACKAGE_ROOT,descriptor.id),path.join(smokePackages,descriptor.id),{recursive:true,errorOnExist:true})
    writePrivate('private-fixture.json',fixture)
    writePrivate('prepared.json',{descriptor,packageFileAudit,sourceCommit,questionUpdatedAt:question.updatedAt})
    console.log(JSON.stringify({prepared:true,packageId:descriptor.id,packageDigest:descriptor.digest,
      changedFiles:packageFileAudit.changedFiles,threshold:40,questionVersion:3,externalModelCalls:0,databaseWrites:0}))
  } else {
    const prepared = JSON.parse(fs.readFileSync(path.join(root,'prepared.json'),'utf8'))
    assert.equal(prepared.sourceCommit,sourceCommit)
    const descriptor = await readEvaluationPackage(prepared.descriptor.id)
    assert.equal(descriptor.digest,prepared.descriptor.digest)
    const newMetadata = JSON.parse(fs.readFileSync(path.join(EVALUATION_PACKAGE_ROOT,descriptor.id,'_metadata.json'),'utf8'))
    assert.deepEqual(auditedPackageFileChanges(oldMetadata.files,newMetadata.files),prepared.packageFileAudit)
    const question = await prisma.question.findUniqueOrThrow({where:{id:fixed.questionId}})
    assert.equal(question.updatedAt.toISOString(),prepared.questionUpdatedAt)
    const previous = await prisma.questionRevision.findUniqueOrThrow({where:{questionId_revision:{questionId:fixed.questionId,revision:2}}})
    planA28QualificationRepair(question,previous.snapshot,descriptor)
    if (mode === 'plan') console.log(JSON.stringify({ready:true,questionId:fixed.questionId,revision:3,threshold:40,packageId:descriptor.id,databaseWrites:0}))
    else {
      const smoke=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'))
      assert.equal(smoke.passed,true);assert.equal(smoke.packageId,descriptor.id);assert.equal(smoke.packageDigest,descriptor.digest)
      assert.equal(smoke.externalModelCalls,0);assert.equal(smoke.productionDatabaseWrites,0)
      const result=await publishA28QualificationRepair(prisma,descriptor,{sourceCommit,packageFileAudit:prepared.packageFileAudit})
      writePrivate('publication.json',{...result,sourceCommit,publishedAt:new Date().toISOString()})
      console.log(JSON.stringify({published:true,...result}))
    }
  }
} finally { await prisma.$disconnect() }
