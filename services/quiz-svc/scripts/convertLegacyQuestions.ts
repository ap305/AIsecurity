/**
 * Resumeable HTTP conversion of the twenty published managed/v2 questions.
 * Run prepare/calibrate/verify against the isolated restored database first.
 * Every publish uses the normal admin endpoint and its package/self-test gate.
 * Credentials are read from a protected token file, never from metadata or logs.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { parseArgs } from 'node:util'
import {
  LEGACY_QUESTION_IDS,
  validateLegacyRecords,
  calibratedLegacyDefinition,
  assertLegacySuccessPolicy,
  validateLegacyAcceptance,
  legacyCalibrationDiagnostic,
  legacyOpponentThresholdDiagnostic,
  assertLegacyCalibrationEvidence,
  assertLegacyVerification,
  validateLegacyMetrics,
  legacyQuestionUpdate,
  matchesPublishedLegacyConversion,
  legacyRecordsMatchForRefresh,
  legacyFrozenPoolMatchesForRefresh,
} from '../src/lib/legacyConversion.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'

const { values } = parseArgs({
  options: {
    metadata: { type: 'string', multiple: true },
    api: { type: 'string' },
    'token-file': { type: 'string' },
    state: { type: 'string' },
    stage: { type: 'string', default: 'prepare' },
    'model-config': { type: 'string' },
    acceptance: { type: 'string' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    'retry-failed': { type: 'boolean', default: false },
    'refresh-from': { type: 'string', multiple: true },
  },
})
if (!values.metadata?.length || !values.api || !values['token-file'] || !values.state)
  throw new Error(
    'Required: --metadata (repeatable) --api --token-file --state; --stage prepare|calibrate|verify|publish',
  )
const stage = values.stage!
if (!['prepare', 'calibrate', 'verify', 'publish'].includes(stage)) throw new Error('Invalid stage')
const target = values.api.replace(/\/$/, '')
const token = fs.readFileSync(values['token-file'], 'utf8').trim()
if (!token || token.includes('\n')) throw new Error('Invalid token file')
const allRows = validateLegacyRecords(
  values.metadata.flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8'))),
)
const acceptanceFile = values.acceptance ? path.resolve(values.acceptance) : null
const acceptance = acceptanceFile
  ? validateLegacyAcceptance(JSON.parse(fs.readFileSync(acceptanceFile, 'utf8')), allRows)
  : {}
for (const [questionId, codePath] of Object.entries(acceptance))
  acceptance[questionId] = path.resolve(path.dirname(acceptanceFile!), codePath)
const selected = values.only ? new Set(values.only.split(',')) : null
if (selected && [...selected].some((id) => !allRows.some((row) => row.questionId === id)))
  throw new Error('Unknown selected question')
const rows = allRows.filter((row) => !selected || selected.has(row.questionId))
if (stage === 'publish' && (selected || rows.length !== LEGACY_QUESTION_IDS.length))
  throw new Error('Final conversion must include all twenty original questions')
const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error('Concurrency must be 1–4')
const stateFile = path.resolve(values.state)
const hash = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')
function canonical(v: any): string {
  return v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(v[key]))
          .join(',')}}`
    : JSON.stringify(v)
}
const metadataHash = hash(canonical(allRows))
const initialStateText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null
const state: any = initialStateText
  ? JSON.parse(initialStateText)
  : {
      schemaVersion: 1,
      target,
      metadataHash,
      createdAt: new Date().toISOString(),
      packages: {},
      pools: {},
      questions: {},
    }
const refreshFrom = values['refresh-from']?.length
  ? validateLegacyRecords(values['refresh-from'].flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8'))))
  : null
if (state.target !== target || state.schemaVersion !== 1)
  throw new Error('State belongs to another target or unsupported schema')
if (refreshFrom) {
  if (stage !== 'prepare' || selected || !initialStateText)
    throw new Error('Explicit refresh requires an existing state, stage=prepare and the full metadata scope')
  if (hash(canonical(refreshFrom)) !== state.metadataHash)
    throw new Error('Previous metadata does not match the frozen state; cannot rewrite its hash')
  const previousIds = new Set(refreshFrom.map((row) => row.questionId))
  if (
    previousIds.size !== allRows.length ||
    allRows.some((row) => !previousIds.has(row.questionId)) ||
    Object.keys(state.questions).some((questionId) => !previousIds.has(questionId))
  )
    throw new Error('Refresh cannot add or remove original questions from the frozen conversion scope')
} else if (state.metadataHash !== metadataHash)
  throw new Error('State belongs to another target or metadata revision; choose a new state file')
function save() {
  state.updatedAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const temporary = stateFile + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, stateFile)
}
function progress(questionId: string, action: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ questionId, action, ...extra }))
}
async function request(route: string, method = 'GET', data?: any) {
  const multipart = data instanceof FormData
  const response = await fetch(target + route, {
    method,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      // Large synchronous ZIP work must not leave the next write reusing an
      // idle connection whose remote close is still waiting on the event loop.
      Connection: 'close',
      ...(data !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : multipart ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(120000),
  })
  const result: any = await response.json()
  if (!response.ok || result.code !== 0)
    throw new Error(`${route}: HTTP ${response.status}: ${String(result.message).slice(0, 400)}`)
  return result.data
}
function packageArchive(directory: string) {
  const zip = new AdmZip(),
    files: Array<[string, string]> = []
  function walk(current: string) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Package links are forbidden')
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const relative = path.relative(directory, full).split(path.sep).join('/')
        const content = fs.readFileSync(full)
        files.push([relative, hash(content)])
        zip.addFile(relative, content)
      } else throw new Error('Unexpected package file type')
    }
  }
  walk(directory)
  return { digest: hash(canonical(files)), zip }
}
const modelConfig = values['model-config']
  ? JSON.parse(fs.readFileSync(values['model-config'], 'utf8'))
  : null
if (modelConfig && Object.keys(modelConfig).some((key) => /password|apiKey|token|secret/i.test(key)))
  throw new Error(
    'Model config must reference a credential environment variable; no secrets in conversion metadata',
  )
const pools: any[] = await request('/admin/api-pool')
function poolBody(row: (typeof rows)[number]) {
  if (!modelConfig) throw new Error('Gateway conversion requires --model-config')
  let modelUrl: URL
  try {
    modelUrl = new URL(modelConfig.baseUrl)
  } catch {
    throw new Error('Invalid model service URL')
  }
  if (
    !['http:', 'https:'].includes(modelUrl.protocol) ||
    modelUrl.username ||
    modelUrl.password ||
    modelUrl.search ||
    modelUrl.hash
  )
    throw new Error('Model service URL must not contain credentials or query data')
  return {
    ...modelConfig,
    name: row.poolSpec!.name,
    kind: 'llm',
    enabled: true,
    isDefault: false,
    baseUrl: modelUrl.toString().replace(/\/$/, ''),
    credentialEnv: modelConfig.credentialEnv || null,
    parameters: { ...row.poolSpec!.parameters, maxCalls: 500, enable_thinking: false },
  }
}
function poolMatches(pool: any, body: any): boolean {
  return ['name', 'kind', 'model', 'modelVersion', 'baseUrl', 'credentialEnv', 'enabled', 'parameters'].every(
    (key) => canonical(pool[key]) === canonical(body[key]),
  )
}
if (refreshFrom) await refreshState(refreshFrom)
for (const row of rows) {
  const q = (state.questions[row.questionId] ||= {})
  if (!q.before) {
    q.before = await request(`/admin/questions/${row.questionId}`)
    save()
  }
  if (
    q.before.id !== row.questionId ||
    q.before.status !== 'published' ||
    q.before.judgeMode !== 'managed' ||
    q.before.judgeVersion !== 'v2'
  )
    throw new Error(`Original question is not the authorized published managed/v2 slot: ${row.questionId}`)
  if (row.poolSpec) {
    const body = poolBody(row)
    const matching = pools.find((p) => (!q.poolId || p.id === q.poolId) && poolMatches(p, body))
    if (q.poolId && (!matching || matching.revision !== q.poolRevision))
      throw new Error(`Frozen model pool changed: ${row.questionId}; use a fresh calibration state`)
    const pool = matching || (await request('/admin/api-pool', 'POST', body))
    if (!matching) pools.push(pool)
    state.pools[row.poolSpec.id] = pool.id
    q.poolId = pool.id
    q.poolRevision = pool.revision
  }
  const archive = packageArchive(row.packageDirectory)
  const referenceDigest = hash(fs.readFileSync(row.referenceCodePath))
  if (q.referenceDigest && q.referenceDigest !== referenceDigest)
    throw new Error('Official reference code changed within conversion state')
  q.referenceDigest = referenceDigest
  let descriptor = state.packages[archive.digest]
  if (descriptor) {
    const verified = await request(`/admin/evaluation-packages/${descriptor.id}/validate`, 'POST')
    if (descriptor.digest !== verified.digest) throw new Error('Previously imported package changed')
  } else {
    const form = new FormData()
    const bytes = archive.zip.toBuffer()
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
      'legacy-conversion.zip',
    )
    descriptor = await request('/admin/evaluation-packages', 'POST', form)
    state.packages[archive.digest] = descriptor
  }
  if (q.packageId && q.packageId !== descriptor.id)
    throw new Error('Question package changed within an existing conversion state')
  q.packageId = descriptor.id
  q.packageDigest = descriptor.digest
  save()
  progress(row.questionId, 'prepared', { packageId: descriptor.id })
}

async function selfTest(
  row: (typeof rows)[number],
  definition: any,
  phase: 'baseline' | 'opponent',
  bucket: 'calibration' | 'verification',
) {
  const q = state.questions[row.questionId],
    proof = (q[bucket] ||= {})
  const material = selfTestMaterial(row, definition, phase, bucket)
  const { configuration } = material
  if (proof[phase] && proof[phase].configuration !== configuration)
    throw new Error('Self-test configuration changed; use a fresh conversion state')
  if (proof[phase] && values['retry-failed']) {
    const previous = await request(`/admin/evaluation-packages/${q.packageId}/self-tests/${proof[phase].id}`)
    if (
      previous.status === 'completed' &&
      previous.result?.status !== 'completed' &&
      previous.result?.cleanupStatus === 'cleaned'
    ) {
      ;(q.failedSelfTests ||= []).push({ ...proof[phase], bucket, phase, record: previous })
      delete proof[phase]
      save()
    }
  }
  if (!proof[phase]) {
    const created = await request(`/admin/evaluation-packages/${q.packageId}/self-tests`, 'POST', {
      code: material.code,
      definition,
      category: 'adversarial',
      role: row.role,
      phase,
      ...(phase === 'opponent' ? { opponent: { code: material.opponentCode } } : {}),
    })
    proof[phase] = { id: created.id, configuration, codeDigest: material.codeDigest, source: material.source }
    save()
  }
  const timeout = definition.evaluation.timeoutMs + 180000
  const deadline = Date.now() + timeout
  progress(row.questionId, `${bucket}:${phase}:running`, { selfTestId: proof[phase].id })
  while (Date.now() < deadline) {
    const actual = await request(`/admin/evaluation-packages/${q.packageId}/self-tests/${proof[phase].id}`)
    if (actual.status === 'completed') {
      proof[phase].record = actual
      save()
      if (actual.result?.status !== 'completed' || actual.result.cleanupStatus !== 'cleaned')
        throw new Error(
          `${row.questionId} ${bucket}/${phase}: ${actual.result?.status}: ${actual.result?.publicMessage}`,
        )
      progress(row.questionId, `${bucket}:${phase}:completed`, { metrics: actual.result.metrics })
      return actual.result.metrics
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error(`Timed out waiting for ${row.questionId} ${bucket}/${phase}`)
}

function readCode(file: string): string {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('Self-test code must be a regular UTF-8 file of at most 1 MiB')
  const bytes = fs.readFileSync(file)
  const code = bytes.toString('utf8')
  if (!code.trim() || !Buffer.from(code, 'utf8').equals(bytes))
    throw new Error('Invalid UTF-8 self-test code')
  return code
}

function selfTestMaterial(
  row: (typeof rows)[number],
  definition: any,
  phase: 'baseline' | 'opponent',
  bucket: 'calibration' | 'verification',
) {
  const q = state.questions[row.questionId]
  const other = allRows.find(
    (candidate) => candidate.scenarioId === row.scenarioId && candidate.role !== row.role,
  )
  if (!other) throw new Error('Missing opposite-role reference')
  // Acceptance code never participates in calibration, including reference-derived thresholds.
  const acceptancePath = bucket === 'verification' ? acceptance[row.questionId] : undefined
  const code = readCode(acceptancePath || row.referenceCodePath)
  const codeDigest = hash(code)
  const opponentCode = readCode(other.referenceCodePath)
  const configuration = hash(
    canonical({
      definition,
      phase,
      role: row.role,
      poolRevision: q.poolRevision,
      referenceDigest: q.referenceDigest,
      opponentReferenceDigest: hash(fs.readFileSync(other.referenceCodePath)),
      // Keep calibration fingerprints compatible with the already-running official-reference runs.
      ...(bucket === 'verification' ? { verificationCodeDigest: codeDigest } : {}),
    }),
  )
  return {
    code,
    codeDigest,
    opponentCode,
    configuration,
    source: acceptancePath ? 'acceptance' : 'official_reference',
  }
}

function verificationIdentity(row: (typeof rows)[number]) {
  const q = state.questions[row.questionId]
  const baseline = selfTestMaterial(row, q.definition, 'baseline', 'verification')
  const opponent = selfTestMaterial(row, q.definition, 'opponent', 'verification')
  return {
    codeDigest: baseline.codeDigest,
    source: baseline.source,
    configurations: { baseline: baseline.configuration, opponent: opponent.configuration },
  }
}

function calibrationDefinition(row: (typeof rows)[number]) {
  const q = state.questions[row.questionId]
  const preliminary = structuredClone(row.definition)
  preliminary.evaluation = {
    ...preliminary.evaluation,
    packageId: q.packageId,
    baselineThreshold: 0,
    successThreshold: 0,
    calibrationMode: true,
  }
  if (preliminary.llm.enabled) preliminary.llm.poolId = q.poolId
  return normalizeDefinition(preliminary)
}

async function refreshState(previousRows: typeof rows) {
  const plans: Array<{ questionId: string; reasons: string[]; previous: any }> = []
  // Read every tracked task before changing anything, including failures. An active
  // or unclean task blocks the whole refresh, even if its question would be reset.
  for (const row of rows) {
    const q = state.questions[row.questionId]
    if (!q) continue
    const proofs = [
      ...Object.values(q.calibration || {}),
      ...Object.values(q.verification || {}),
      ...(q.failedSelfTests || []),
      ...(q.verificationHistory || []).flatMap((item: any) => Object.values(item.proof || {})),
    ] as any[]
    const inspected = new Map<string, any>()
    for (const proof of proofs) {
      if (typeof proof?.id !== 'string' || !proof.id || !q.packageId)
        throw new Error(`Invalid tracked self-test identity: ${row.questionId}`)
      const actual =
        inspected.get(proof.id) ||
        (await request(`/admin/evaluation-packages/${q.packageId}/self-tests/${proof.id}`))
      if (actual.status !== 'completed' || actual.result?.cleanupStatus !== 'cleaned')
        throw new Error(`Refresh blocked by active or unclean self-test: ${row.questionId}/${proof.id}`)
      inspected.set(proof.id, actual)
      proof.record = actual
    }
  }
  for (const row of rows) {
    const q = state.questions[row.questionId] || {}
    const previous = previousRows.find((candidate) => candidate.questionId === row.questionId)!
    const reasons: string[] = []
    if (!legacyRecordsMatchForRefresh(previous, row)) reasons.push('course_metadata_changed')
    if (!q.before || !q.packageId) reasons.push('not_prepared')
    const archive = packageArchive(row.packageDirectory)
    const descriptor = state.packages[archive.digest]
    if (!descriptor || descriptor.id !== q.packageId || descriptor.digest !== q.packageDigest)
      reasons.push('package_files_changed')
    else {
      const actual = await request(`/admin/evaluation-packages/${descriptor.id}/validate`, 'POST')
      if (actual.digest !== descriptor.digest)
        throw new Error(`Previously imported immutable package changed: ${row.questionId}`)
    }
    if (q.referenceDigest !== hash(fs.readFileSync(row.referenceCodePath)))
      reasons.push('official_reference_changed')
    if (row.poolSpec) {
      const pool = pools.find((candidate) => candidate.id === q.poolId)
      if (!legacyFrozenPoolMatchesForRefresh(pool, q, poolBody(row))) reasons.push('frozen_model_changed')
    } else if (q.poolId) reasons.push('frozen_model_removed')
    if (q.packageId) {
      const preliminary = calibrationDefinition(row)
      for (const [phase, proof] of Object.entries(q.calibration || {}) as Array<
        ['baseline' | 'opponent', any]
      >) {
        const expected = selfTestMaterial(row, preliminary, phase, 'calibration')
        if (proof.configuration !== expected.configuration)
          reasons.push(`calibration_${phase}_configuration_changed`)
      }
      if (q.verification) {
        if (!q.definition) reasons.push('verification_definition_missing')
        else {
          const identity = verificationIdentity(row)
          for (const [phase, proof] of Object.entries(q.verification) as Array<
            ['baseline' | 'opponent', any]
          >) {
            if (
              proof.configuration !== identity.configurations[phase] ||
              proof.codeDigest !== identity.codeDigest
            )
              reasons.push(`verification_${phase}_configuration_changed`)
          }
          if (q.verifiedAt) {
            try {
              assertLegacyVerification(
                q.definition,
                q.verification,
                identity.configurations,
                identity.codeDigest,
              )
            } catch {
              reasons.push('verification_no_longer_qualified')
            }
          }
        }
      }
    }
    if (q.before) {
      const current = await request(`/admin/questions/${row.questionId}`)
      if (q.published) {
        if (
          reasons.length ||
          !q.definition ||
          !matchesPublishedLegacyConversion(
            current,
            q.before,
            legacyQuestionUpdate(row, q.definition),
            q.packageDigest,
          )
        )
          throw new Error(`Cannot refresh an already-published conversion: ${row.questionId}`)
      } else if (
        current.updatedAt !== q.before.updatedAt ||
        current.revision !== q.before.revision ||
        current.status !== 'published' ||
        current.judgeMode !== 'managed' ||
        current.judgeVersion !== 'v2'
      )
        throw new Error(`Original question changed before refresh: ${row.questionId}`)
    }
    plans.push({ questionId: row.questionId, reasons: [...new Set(reasons)], previous: structuredClone(q) })
  }
  // The old CLI may still be finishing its last report; never overwrite concurrent progress.
  if (fs.readFileSync(stateFile, 'utf8') !== initialStateText)
    throw new Error('Conversion state changed during refresh; wait for the entire previous run to finish')
  const audit = {
    at: new Date().toISOString(),
    fromMetadataHash: state.metadataHash,
    toMetadataHash: metadataHash,
    reused: plans.filter((plan) => !plan.reasons.length).map((plan) => plan.questionId),
    invalidated: plans.filter((plan) => plan.reasons.length),
  }
  for (const plan of audit.invalidated) {
    state.questions[plan.questionId] = {
      ...(plan.previous.before ? { before: plan.previous.before } : {}),
      invalidatedAt: audit.at,
      refreshReasons: plan.reasons,
      ...(plan.previous.error ? { priorError: plan.previous.error } : {}),
    }
  }
  ;(state.refreshHistory ||= []).push(audit)
  state.metadataHash = metadataHash
  save()
  progress('*', 'refreshed', {
    reused: audit.reused,
    invalidated: audit.invalidated.map(({ questionId, reasons }) => ({ questionId, reasons })),
  })
}

async function prepareVerification(row: (typeof rows)[number]) {
  const q = state.questions[row.questionId]
  const identity = verificationIdentity(row)
  if (
    q.verification &&
    Object.entries(identity.configurations).some(
      ([phase, configuration]) =>
        q.verification[phase] &&
        (q.verification[phase].configuration !== configuration ||
          q.verification[phase].codeDigest !== identity.codeDigest),
    )
  ) {
    // Reuse completed calibration when the acceptance example changes, never a stale verification.
    for (const proof of Object.values(q.verification) as any[]) {
      const previous = await request(`/admin/evaluation-packages/${q.packageId}/self-tests/${proof.id}`)
      if (previous.status !== 'completed' || previous.result?.cleanupStatus !== 'cleaned')
        throw new Error(
          'Previous verification is still active or unclean; finish it before changing acceptance material',
        )
      proof.record = previous
    }
    ;(q.verificationHistory ||= []).push({
      proof: q.verification,
      verifiedAt: q.verifiedAt,
      supersededAt: new Date().toISOString(),
    })
    delete q.verification
    delete q.verifiedAt
    delete q.verifiedMaterial
    save()
  }
  return identity
}

async function execute(row: (typeof rows)[number]) {
  const q = state.questions[row.questionId]
  if (stage === 'calibrate') {
    const definition = calibrationDefinition(row)
    const baseline = await selfTest(row, definition, 'baseline', 'calibration')
    const opponent = await selfTest(row, definition, 'opponent', 'calibration')
    q.definition = calibratedLegacyDefinition(row, q.packageId, { baseline, opponent }, q.poolId)
    q.calibrationEvidence = {
      provenance: row.provenance,
      policy: row.calibration,
      baseline,
      opponent,
      packageDigest: q.packageDigest,
      poolId: q.poolId,
      poolRevision: q.poolRevision,
      comparison: '>=',
      referenceBaseline: legacyCalibrationDiagnostic(row, q.definition, baseline),
      opponentThreshold: legacyOpponentThresholdDiagnostic(row, opponent),
    }
    q.calibrationStatus = q.calibrationEvidence.referenceBaseline.status
    delete q.error
    save()
    progress(
      row.questionId,
      q.calibrationStatus === 'requires_acceptance' ? 'requires_acceptance' : 'calibrated',
      {
        baselineThreshold: q.definition.evaluation.baselineThreshold,
        successThreshold: q.definition.evaluation.successThreshold,
        referenceBaseline: q.calibrationEvidence.referenceBaseline,
        opponentThreshold: q.calibrationEvidence.opponentThreshold,
      },
    )
  } else if (stage === 'verify') {
    if (!q.definition || !q.calibrationEvidence) throw new Error('Missing actual calibration evidence')
    assertCalibrationEvidence(row)
    assertLegacySuccessPolicy(row, q.definition)
    const identity = await prepareVerification(row)
    const baseline = await selfTest(row, q.definition, 'baseline', 'verification')
    if (
      validateLegacyMetrics(baseline, q.definition.evaluation.baselineMetric) <
      q.definition.evaluation.baselineThreshold
    )
      throw new Error(
        'Selected acceptance material did not pass the frozen qualification threshold; publication remains blocked',
      )
    const opponent = await selfTest(row, q.definition, 'opponent', 'verification')
    validateLegacyMetrics(opponent, q.definition.evaluation.successMetric)
    assertLegacyVerification(q.definition, q.verification, identity.configurations, identity.codeDigest)
    delete q.error
    q.verifiedAt = new Date().toISOString()
    q.verifiedMaterial = { codeDigest: identity.codeDigest, source: identity.source }
    save()
  }
}

function assertCalibrationEvidence(row: (typeof rows)[number]) {
  const q = state.questions[row.questionId]
  const preliminary = calibrationDefinition(row)
  const metrics: any = {}
  for (const phase of ['baseline', 'opponent'] as const) {
    const proof = q.calibration?.[phase]
    if (
      proof?.configuration !== selfTestMaterial(row, preliminary, phase, 'calibration').configuration ||
      proof?.record?.status !== 'completed' ||
      proof.record.result?.status !== 'completed' ||
      proof.record.result.cleanupStatus !== 'cleaned'
    )
      throw new Error('Missing completed original calibration for the exact frozen configuration')
    metrics[phase] = proof.record.result.metrics
  }
  assertLegacyCalibrationEvidence(row, q.definition, metrics, q.calibrationEvidence, {
    packageId: q.packageId,
    poolId: q.poolId,
  })
}

if (stage === 'calibrate' || stage === 'verify') {
  const errors: Array<{ questionId: string; error: string }> = []
  let cursor = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++]
        try {
          await execute(row)
        } catch (error) {
          const message = String(error).split(token).join('[REDACTED]')
          errors.push({ questionId: row.questionId, error: message })
          state.questions[row.questionId].error = message
          save()
          progress(row.questionId, 'failed', { error: message })
        }
      }
    }),
  )
  if (errors.length) throw new Error(`${errors.length} conversion checks failed; see protected state report`)
}
if (stage === 'publish') {
  // Complete the entire readiness check before changing the first original question.
  for (const row of rows) {
    const q = state.questions[row.questionId]
    if (!q.verifiedAt || !q.definition || q.definition.evaluation.calibrationMode)
      throw new Error(`Not ready: ${row.questionId}`)
    assertCalibrationEvidence(row)
    const identity = verificationIdentity(row)
    assertLegacyVerification(q.definition, q.verification, identity.configurations, identity.codeDigest)
    const current = await request(`/admin/questions/${row.questionId}`)
    if (
      matchesPublishedLegacyConversion(
        current,
        q.before,
        legacyQuestionUpdate(row, q.definition),
        q.packageDigest,
      )
    ) {
      q.published = { revision: current.revision, updatedAt: current.updatedAt }
      save()
    } else if (q.published || current.updatedAt !== q.before.updatedAt)
      throw new Error(`Original question changed during rehearsal: ${row.questionId}`)
  }
  for (const row of rows) {
    const q = state.questions[row.questionId]
    if (!q.published) {
      const current = await request(`/admin/questions/${row.questionId}`)
      if (current.updatedAt !== q.before.updatedAt)
        throw new Error(`Question changed before publication: ${row.questionId}`)
      const update = legacyQuestionUpdate(row, q.definition)
      const published = await request(`/admin/questions/${row.questionId}`, 'PUT', update)
      if (!matchesPublishedLegacyConversion(published, q.before, update, q.packageDigest))
        throw new Error(`Published question differs from the verified conversion: ${row.questionId}`)
      q.published = { revision: published.revision, updatedAt: published.updatedAt }
      save()
    }
    progress(row.questionId, 'published', q.published)
  }
}
save()
console.log(JSON.stringify({ stage, questions: rows.length, stateFile, complete: true }))
