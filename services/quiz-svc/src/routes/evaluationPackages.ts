import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { bearerToken, readScopedToken, requireAdminMw, signScopedToken } from '../lib/auth.js'
import { freezePoolBinding, callPoolWithResponseSnapshot } from '../services/apiPool.js'
import { responseSnapshotContext, type ResponseSnapshotContext } from '../services/modelResponseSnapshot.js'
import { normalizeCategory, normalizeDefinition, type PoolBinding } from '../lib/prdContract.js'
import { selfTestConfigurationKey } from '../lib/selfTestContract.js'
import {
  ARCHIVE_LIMITS,
  EVALUATION_EXAMPLE_ROOT,
  EVALUATION_PACKAGE_ROOT,
  PackageValidationError,
  getEvaluationPackage,
  importEvaluationArchive,
  importEvaluationDirectory,
  listEvaluationPackages,
  packageDirectory,
  safeRelativeName,
} from '../lib/evaluationPackage.js'
import {
  runComposeEvaluation,
  type ComposeEvaluationInput,
  type ComposeEvaluationResult,
} from '../services/composeJudge.js'

const router = Router()
router.use('/admin/evaluation-packages', requireAdminMw)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ARCHIVE_LIMITS.compressedBytes, files: 1, fields: 0 },
})
export interface PackageSelfTest {
  id: string
  packageId: string
  packageDigest: string
  createdAt: string
  completedAt?: string
  status: 'queued' | 'running' | 'completed'
  phase: ComposeEvaluationInput['phase']
  configurationKey: string
  result?: ComposeEvaluationResult
  calls?: number
  poolBinding?: PoolBinding
  responseSnapshot?: ResponseSnapshotContext
  upstreamCalls?: number
  responseSnapshotHits?: number
}
function testDirectory(packageId: string, root = EVALUATION_PACKAGE_ROOT): string {
  return path.join(packageDirectory(packageId, root), '_self-tests')
}
function testFile(packageId: string, testId: string, root = EVALUATION_PACKAGE_ROOT): string {
  if (!/^[0-9a-f-]{36}$/.test(testId)) throw new PackageValidationError('自测ID无效')
  return path.join(testDirectory(packageId, root), `${testId}.json`)
}
function saveTest(test: PackageSelfTest): void {
  const directory = testDirectory(test.packageId)
  fs.mkdirSync(directory, { recursive: true })
  const target = testFile(test.packageId, test.id)
  const tmp = path.join(directory, `${test.id}.${crypto.randomUUID()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(test), { flag: 'wx', mode: 0o600 })
  fs.renameSync(tmp, target)
}
function publicTest(test: PackageSelfTest): Omit<PackageSelfTest, 'poolBinding' | 'responseSnapshot'> {
  const { poolBinding: _binding, responseSnapshot: _snapshot, ...publicData } = test
  return publicData
}
async function reserveSelfTestCall(
  packageId: string,
  testId: string,
  digest: string,
  expectedPool: PoolBinding,
  source?: 'upstream' | 'snapshot',
): Promise<{ binding: PoolBinding; snapshot?: ResponseSnapshotContext }> {
  const file = testFile(packageId, testId),
    lock = `${file}.lock`
  let owned = false
  for (let n = 0; n < 30; n++) {
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600)
      fs.closeSync(descriptor)
      owned = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!owned) throw new PackageValidationError('自测调用繁忙，请稍后重试')
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as PackageSelfTest
    if (
      record.status !== 'running' ||
      record.packageDigest !== digest ||
      !record.poolBinding ||
      record.poolBinding.poolId !== expectedPool.poolId ||
      record.poolBinding.revision !== expectedPool.revision
    )
      throw new PackageValidationError('自测调用资格失效')
    if (source) {
      if (!record.responseSnapshot) throw new PackageValidationError('自测快照配置失效')
      if (source === 'upstream') record.upstreamCalls = (record.upstreamCalls ?? 0) + 1
      else record.responseSnapshotHits = (record.responseSnapshotHits ?? 0) + 1
    } else {
      const maxCalls = Number(record.poolBinding.parameters.maxCalls ?? 32)
      if ((record.calls ?? 0) >= Math.min(1000, maxCalls))
        throw new PackageValidationError('自测模型调用额度已用完')
      record.calls = (record.calls ?? 0) + 1
    }
    saveTest(record)
    return { binding: record.poolBinding, snapshot: record.responseSnapshot }
  } finally {
    fs.rmSync(lock, { force: true })
  }
}
export async function getSuccessfulPackageSelfTest(
  packageId: string,
  phase?: ComposeEvaluationInput['phase'],
  root = EVALUATION_PACKAGE_ROOT,
  configurationKey?: string,
): Promise<PackageSelfTest | null> {
  const descriptor = await getEvaluationPackage(packageId, root)
  const directory = testDirectory(packageId, root)
  if (!fs.existsSync(directory)) return null
  const matches: PackageSelfTest[] = []
  for (const name of fs.readdirSync(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
    try {
      const test = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as PackageSelfTest
      if (
        test.packageId === packageId &&
        test.packageDigest === descriptor.digest &&
        (!phase || test.phase === phase) &&
        (!configurationKey || test.configurationKey === configurationKey) &&
        test.status === 'completed' &&
        test.result?.status === 'completed' &&
        test.result.cleanupStatus === 'cleaned'
      )
        matches.push(test)
    } catch {
      /* An invalid test never permits publishing. */
    }
  }
  return matches.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0] ?? null
}
function badRequest(res: import('express').Response, error: unknown): void {
  const message = error instanceof PackageValidationError ? error.message : '环境包配置、材料或操作无效'
  res.status(400).json({ code: 40000, message, data: null })
}
router.get('/admin/evaluation-packages', async (_req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await listEvaluationPackages() })
  } catch (error) {
    badRequest(res, error)
  }
})
router.post('/admin/evaluation-packages', (req, res) => {
  upload.single('file')(req, res, async (error) => {
    if (error) return badRequest(res, new PackageValidationError(`请上传一个不超过${ARCHIVE_LIMITS.compressedBytes / 1024 / 1024}MB的ZIP环境包`))
    try {
      if (!req.file || !req.file.originalname.toLowerCase().endsWith('.zip'))
        throw new PackageValidationError('请上传ZIP环境包')
      const descriptor = await importEvaluationArchive(req.file.buffer)
      res.status(201).json({ code: 0, message: '环境包检查通过', data: descriptor })
    } catch (e) {
      badRequest(res, e)
    }
  })
})
router.post('/admin/evaluation-packages/examples/:name', async (req, res) => {
  try {
    const name = req.params.name
    if (!['basic-algorithm', 'model-inference', 'attack-defense'].includes(name))
      throw new PackageValidationError('示例环境包不存在')
    res
      .status(201)
      .json({
        code: 0,
        message: '示例环境包检查通过',
        data: await importEvaluationDirectory(path.join(EVALUATION_EXAMPLE_ROOT, name)),
      })
  } catch (error) {
    badRequest(res, error)
  }
})
router.post('/admin/evaluation-packages/:id/validate', async (req, res) => {
  try {
    const descriptor = await getEvaluationPackage(req.params.id)
    res.json({
      code: 0,
      message: '环境包检查通过',
      data: {
        ...descriptor,
        checks: ['archive_paths', 'file_digests', 'manifest', 'compose_allowlist', 'entrypoint', 'resources'],
      },
    })
  } catch (error) {
    badRequest(res, error)
  }
})
router.post('/admin/evaluation-packages/:id/self-tests', async (req, res) => {
  try {
    const descriptor = await getEvaluationPackage(req.params.id)
    const body = req.body as Record<string, unknown>
    if (typeof body.code !== 'string' || !body.code.trim())
      throw new PackageValidationError('自测代码不能为空')
    if (!body.definition) throw new PackageValidationError('自测须提供完整题目配置')
    const definition = normalizeDefinition(body.definition)
    if (definition.evaluation.packageId !== descriptor.id)
      throw new PackageValidationError('自测配置与所选环境包不一致')
    if (typeof body.category !== 'string' || !['basic', 'adversarial', 'security'].includes(body.category))
      throw new PackageValidationError('自测题目分类无效')
    const category = normalizeCategory(body.category)
    const role = body.role == null ? undefined : body.role
    if (role !== undefined && !['attack', 'defense'].includes(String(role)))
      throw new PackageValidationError('自测角色无效')
    if (category === 'adversarial' && !role) throw new PackageValidationError('攻防自测须指定固定角色')
    const phase = body.phase ?? descriptor.manifest.phases[0]
    if (!['basic', 'baseline', 'opponent'].includes(String(phase)))
      throw new PackageValidationError('自测阶段无效')
    if (!descriptor.manifest.phases.includes(phase as ComposeEvaluationInput['phase']))
      throw new PackageValidationError('环境包不支持该自测阶段')
    let filePath: string | null = null
    const directory = packageDirectory(descriptor.id)
    if (body.weightFixture !== undefined) {
      if (typeof body.weightFixture !== 'string') throw new PackageValidationError('参数fixture无效')
      const name = safeRelativeName(body.weightFixture)
      if (!name.startsWith('fixtures/')) throw new PackageValidationError('自测参数须来自包内fixtures目录')
      filePath = path.join(directory, name)
    }
    const id = crypto.randomUUID()
    const modelBinding = definition.llm.enabled
      ? await freezePoolBinding(definition.llm.poolId!, 'llm')
      : undefined
    if ((descriptor.manifest.network === 'gateway') !== definition.llm.enabled)
      throw new PackageValidationError('模型网关与环境包网络配置不一致')
    const configurationKey = selfTestConfigurationKey(
      definition,
      role ? String(role) : null,
      category,
      modelBinding,
    )
    const record: PackageSelfTest = {
      id,
      packageId: descriptor.id,
      packageDigest: descriptor.digest,
      configurationKey,
      createdAt: new Date().toISOString(),
      status: 'queued',
      phase: phase as ComposeEvaluationInput['phase'],
      calls: 0,
      ...(definition.llm.enabled && responseSnapshotContext(definition, descriptor.digest)
        ? { responseSnapshot: responseSnapshotContext(definition, descriptor.digest)! } : {}),
    }
    const opponentBody = body.opponent as { code?: unknown; weightFixture?: unknown } | undefined
    let opponentFilePath: string | null = null
    if (opponentBody?.weightFixture !== undefined) {
      if (typeof opponentBody.weightFixture !== 'string')
        throw new PackageValidationError('对手参数fixture无效')
      const name = safeRelativeName(opponentBody.weightFixture)
      if (!name.startsWith('fixtures/')) throw new PackageValidationError('对手参数须来自包内fixtures目录')
      opponentFilePath = path.join(directory, name)
    }
    const input: ComposeEvaluationInput = {
      submissionId: `self-test-${id}`,
      attemptId: id,
      questionVersion: 1,
      evaluationVersion: descriptor.digest,
      packageId: descriptor.id,
      code: body.code,
      filePath,
      phase: phase as ComposeEvaluationInput['phase'],
      role: role as ComposeEvaluationInput['role'],
      parameters: definition.evaluation,
      timeoutMs: definition.evaluation.timeoutMs,
      baseline: {
        code:
          typeof definition.evaluation.baselineCode === 'string'
            ? definition.evaluation.baselineCode
            : undefined,
        fixture:
          typeof definition.evaluation.baselineFixture === 'string'
            ? definition.evaluation.baselineFixture
            : undefined,
        weightFixture:
          typeof definition.evaluation.baselineWeightFixture === 'string'
            ? definition.evaluation.baselineWeightFixture
            : undefined,
      },
      opponent:
        opponentBody && typeof opponentBody.code === 'string'
          ? { submissionId: `fixture-${id}`, code: opponentBody.code, filePath: opponentFilePath }
          : undefined,
    }
    if (input.phase === 'opponent' && !input.opponent)
      throw new PackageValidationError('对抗自测必须提供对手代码')
    if (descriptor.manifest.network === 'gateway') {
      record.poolBinding = modelBinding!
      const base = (process.env.EVALUATION_GATEWAY_URL || 'http://host.docker.internal:4002/api').replace(
        /\/$/,
        '',
      )
      input.modelGateway = {
        url: `${base}/evaluation-self-test-gateway/${id}`,
        token: signScopedToken({
          purpose: 'selftest',
          packageId: descriptor.id,
          testId: id,
          packageDigest: descriptor.digest,
          poolBinding: record.poolBinding,
          exp: Date.now() + descriptor.manifest.resources.timeoutMs + 60000,
        }),
      }
    }
    saveTest(record)
    res.status(202).json({ code: 0, message: '自测已创建', data: publicTest(record) })
    setImmediate(async () => {
      record.status = 'running'
      try {
        saveTest(record)
        record.result = await runComposeEvaluation(input, { materialRoots: [directory] })
      } catch {
        record.result = {
          status: 'system_error',
          publicMessage: '自测执行失败',
          cleanupStatus: 'not_started',
        }
      }
      record.status = 'completed'
      record.completedAt = new Date().toISOString()
      try {
        const current = JSON.parse(fs.readFileSync(testFile(record.packageId, record.id), 'utf8')) as PackageSelfTest
        record.calls = current.calls ?? 0
        if (record.responseSnapshot) {
          record.upstreamCalls = current.upstreamCalls ?? 0
          record.responseSnapshotHits = current.responseSnapshotHits ?? 0
        }
      } catch {
        /* preserve conservative zero when evidence is lost */
      }
      try {
        saveTest(record)
      } catch {
        /* Missing evidence must block publishing. */
      }
    })
  } catch (error) {
    badRequest(res, error)
  }
})
router.get('/admin/evaluation-packages/:id/self-tests/:testId', async (req, res) => {
  try {
    await getEvaluationPackage(req.params.id)
    const record = JSON.parse(
      fs.readFileSync(testFile(req.params.id, req.params.testId), 'utf8'),
    ) as PackageSelfTest
    res.json({ code: 0, message: 'ok', data: publicTest(record) })
  } catch (error) {
    badRequest(res, error)
  }
})
router.post('/evaluation-self-test-gateway/:testId/chat/completions', async (req, res) => {
  try {
    const token = readScopedToken(bearerToken(req), 'selftest')
    if (
      !token ||
      token.testId !== req.params.testId ||
      typeof token.packageId !== 'string' ||
      typeof token.packageDigest !== 'string' ||
      !token.poolBinding
    )
      return res.status(403).json({ code: 40300, message: '自测访问资格失效', data: null })
    const descriptor = await getEvaluationPackage(token.packageId)
    if (descriptor.digest !== token.packageDigest) throw new PackageValidationError('环境包版本已失效')
    const reserved = await reserveSelfTestCall(
      token.packageId,
      token.testId,
      token.packageDigest,
      token.poolBinding as PoolBinding,
    )
    res.json(await callPoolWithResponseSnapshot(reserved.binding, req.body, reserved.snapshot, async source => {
      await reserveSelfTestCall(token.packageId as string, token.testId as string, token.packageDigest as string, token.poolBinding as PoolBinding, source)
      res.setHeader('X-Model-Response-Source', source)
    }))
  } catch (error) {
    const status =
      typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 400
    res.status(status).json({ code: status * 100, message: '自测网关调用失败或额度已用完', data: null })
  }
})
export default router
