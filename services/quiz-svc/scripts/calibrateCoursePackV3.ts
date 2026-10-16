/** Reference calibration creates only immutable packages and their self-tests.
 * No Question, Submission, score or leaderboard rows are changed here.
 * The final manifest is written only after all 77 real Docker evaluations pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import AdmZip from 'adm-zip'
import { loadCoursePack, sha256, type CoursePackQuestion } from './importCoursePackV3.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import { decodeEvaluationArchive } from '../src/lib/evaluationPackage.js'

export function thresholds(baseline: number, success: number, floor?: number) {
  if (!Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(success) || success < 0 || success > 1)
    throw new Error('reference_failed_qualification_or_metric_range')
  if (success === 0 && (!Number.isFinite(floor) || floor! <= 0 || floor! > 1))
    throw new Error('zero_reference_requires_documented_positive_threshold')
  return { baselineThreshold: baseline, successThreshold: success === 0 ? floor! : success }
}

type Phase = 'basic' | 'baseline' | 'opponent'
interface Proof { intent?: boolean; id?: string; configurationKey?: string; record?: any; failed?: string[] }
interface Options { manifest: string; evidence: string; state: string; output: string; api: string; tokenFile: string;
  poolMap?: string; only?: string[]; recover?: string; retryFailed?: boolean; pollMs?: number; selfTestTimeoutMs?: number; log?: (event: any) => void }
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const validTestId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function leanRecord(record: any) {
  const result = record.result
  if (!object(result)) throw new Error('self_test_result_missing')
  const metrics: Record<string, number> = {}
  if (result.metrics !== undefined) {
    if (!object(result.metrics) || Object.keys(result.metrics).length > 100) throw new Error('self_test_metrics_invalid')
    for (const [key, value] of Object.entries(result.metrics)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value)) throw new Error('self_test_metrics_invalid')
      metrics[key] = value
    }
  }
  return { id: record.id, packageId: record.packageId, packageDigest: record.packageDigest, phase: record.phase,
    configurationKey: record.configurationKey, status: record.status,
    ...(Number.isSafeInteger(record.calls) && record.calls >= 0 ? { calls: record.calls } : {}),
    result: { status: result.status, cleanupStatus: result.cleanupStatus, metrics,
      ...(typeof result.score === 'number' ? { score: result.score } : {}),
      ...(typeof result.maxScore === 'number' ? { maxScore: result.maxScore } : {}) } }
}

export async function calibrate(options: Options) {
  const { manifest, root, manifestDigest } = loadCoursePack(path.resolve(options.manifest))
  const evidence = JSON.parse(fs.readFileSync(options.evidence, 'utf8'))
  if (!Array.isArray(evidence.questions)) throw new Error('build_evidence_missing')
  if (!/@sha256:[a-f0-9]{64}$/.test(evidence.image)) throw new Error('calibration_requires_immutable_production_image')
  if (path.dirname(path.resolve(options.output)) !== root) throw new Error('final_manifest_must_share_input_root')
  if (fs.existsSync(options.output)) throw new Error('final_manifest_already_exists')
  const evidenceDigest = sha256(fs.readFileSync(options.evidence))
  const poolMap = options.poolMap ? JSON.parse(fs.readFileSync(options.poolMap, 'utf8')) : {}
  const recovery = options.recover ? JSON.parse(fs.readFileSync(options.recover, 'utf8')) : {}
  const selected = manifest.questions.filter(q => !options.only || options.only.includes(q.id))
  if (!selected.length || options.only && (new Set(options.only).size !== options.only.length || options.only.some(id => !selected.some(q => q.id === id)))) throw new Error('invalid_question_selection')
  const statePath = path.resolve(options.state)
  if ([options.manifest, options.evidence, options.output, options.tokenFile, options.poolMap, options.recover].filter(Boolean).some(file => path.resolve(file!) === statePath)) throw new Error('state_path_conflicts_with_input')
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  let lock: number
  try { lock = fs.openSync(statePath + '.lock', 'wx', 0o600) } catch { throw new Error('calibration_state_locked') }
  try {
  const state: { manifestDigest: string; evidenceDigest: string; api: string; packages: Record<string, any>;
                 pools: Record<string, any>; tests: Record<string, Partial<Record<Phase, Proof>>> } =
    fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) :
    { manifestDigest, evidenceDigest, api: options.api, packages: {}, pools: {}, tests: {} }
  if (state.manifestDigest !== manifestDigest || state.evidenceDigest !== evidenceDigest || state.api !== options.api)
    throw new Error('calibration_input_changed')
  if (!object(state.packages) || !object(state.pools) || !object(state.tests) ||
      Object.values(state.packages).some(p => !object(p) || !validId(p.id))) throw new Error('calibration_state_invalid')
  const save = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(statePath + '.tmp', statePath)
  }
  const log = options.log ?? ((item) => console.log(JSON.stringify(item)))
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim()
  if (token.length < 16 || /\s/.test(token)) throw new Error('invalid_token_file')
  const api = new URL(options.api)
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || !/\/api\/?$/.test(api.pathname))
    throw new Error('invalid_api_url')
  async function request(route: string, method = 'GET', body?: any) {
    let response: Response
    try {
      response = await fetch(options.api.replace(/\/$/, '') + route, { method,
        headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000) })
    } catch { throw new Error('http_outcome_unknown') }
    if (!response.ok) throw new Error(`http_${response.status}_calibration_failed`)
    let payload: any
    try { payload = await response.json() } catch { throw new Error('calibration_api_invalid_json') }
    if (!object(payload) || payload.code !== 0) throw new Error('calibration_api_rejected_request')
    return payload.data
  }
  const pools = await request('/admin/api-pool')
  if (!Array.isArray(pools)) throw new Error('invalid_pool_list')
  for (const q of selected.filter(q => q.definition.llm.enabled)) {
    const id = poolMap[q.id] ?? q.definition.llm.poolId
    const pool = pools.find((p: any) => p.id === id && p.enabled && p.kind === 'llm')
    if (!pool) throw new Error('required_actual_model_pool_unavailable')
    const frozen = { id: pool.id, revision: pool.revision, model: pool.model, modelVersion: pool.modelVersion,
                     baseUrl: pool.baseUrl, credentialEnv: pool.credentialEnv, parameters: pool.parameters }
    const fingerprint = sha256(JSON.stringify(frozen))
    if (state.pools[q.id] && state.pools[q.id].fingerprint !== fingerprint) throw new Error('frozen_model_pool_changed')
    state.pools[q.id] = { id, fingerprint, revision: pool.revision, model: pool.model, modelVersion: pool.modelVersion }
  }
  save()
  const keys = new Set(selected.map(q => q.packageKey))
  const expectedPackages: Record<string, string> = {}
  // Validate every source image before the first package upload. A selected
  // subset cannot conceal a mutable or mismatched image in the final bundle.
  for (const pkg of manifest.packages) {
    const sourceManifest = JSON.parse(fs.readFileSync(path.resolve(root, pkg.directory, 'manifest.json'), 'utf8'))
    if (sourceManifest.image !== evidence.image) throw new Error('package_source_image_mismatch')
  }
  const installedPackages = await request('/admin/evaluation-packages')
  if (!Array.isArray(installedPackages)) throw new Error('invalid_package_list')
  for (const pkg of manifest.packages) {
    const directory = path.resolve(root, pkg.directory)
    const zip = new AdmZip()
    for (const file of [...pkg.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const data = fs.readFileSync(path.join(directory, file.path))
      if (sha256(data) !== file.sha256) throw new Error('package_input_changed')
      zip.addFile(file.path, data)
    }
    const bytes = zip.toBuffer()
    const expectedDigest = sha256(JSON.stringify(Object.fromEntries([...decodeEvaluationArchive(bytes)].map(([name, data]) => [name, sha256(data)]))))
    expectedPackages[pkg.key] = expectedDigest
    if (!keys.has(pkg.key)) continue
    const inputDigest = sha256(JSON.stringify(pkg.files))
    if (state.packages[pkg.key]) {
      if (state.packages[pkg.key].inputDigest !== inputDigest) throw new Error('package_input_changed')
      const actual = await request(`/admin/evaluation-packages/${state.packages[pkg.key].id}/validate`, 'POST')
      if (actual.id !== state.packages[pkg.key].id || actual.digest !== expectedDigest || actual.digest !== state.packages[pkg.key].digest || actual.valid !== true || actual.manifest?.image !== evidence.image) throw new Error('installed_package_changed')
    } else {
      // The server allocates UUIDs, so first reconcile by the full immutable
      // content digest after an interrupted upload instead of creating copies.
      let installed = installedPackages.find((p: any) => object(p) && p.digest === expectedDigest && p.manifest?.image === evidence.image)
      if (!installed) {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(bytes)]), `${pkg.key}.zip`)
        installed = await request('/admin/evaluation-packages', 'POST', form)
        installedPackages.push(installed)
      }
      if (!validId(installed.id) || installed.digest !== expectedDigest || installed.manifest?.image !== evidence.image) throw new Error('installed_package_or_image_mismatch')
      const verified = await request(`/admin/evaluation-packages/${installed.id}/validate`, 'POST')
      if (verified.id !== installed.id || verified.digest !== expectedDigest || verified.valid !== true || verified.manifest?.image !== evidence.image) throw new Error('installed_package_changed')
      state.packages[pkg.key] = { id: installed.id, digest: installed.digest, inputDigest }
      save()
      log({ event: 'calibration_package_installed', key: pkg.key })
    }
  }
  function contract(q: CoursePackQuestion, phase: Phase) {
    const pkg = state.packages[q.packageKey]
    const definition = structuredClone(q.definition)
    definition.evaluation = { ...definition.evaluation, packageId: pkg.id, calibrationMode: true,
                              baselineThreshold: 0, successThreshold: 1 }
    const fixtureDigest = (fixture?: string) => fixture ? manifest.packages.find(p => p.key === q.packageKey)!.files.find(f => f.path === fixture)!.sha256 : null
    const referenceBinding = sha256(JSON.stringify({ manifestDigest, questionId: q.id, phase,
      code: q.selfTest.codeSha256, weights: fixtureDigest(q.selfTest.weightFixture),
      opponentCode: phase === 'opponent' ? q.selfTest.opponent?.codeSha256 : null,
      opponentWeights: phase === 'opponent' ? fixtureDigest(q.selfTest.opponent?.weightFixture) : null }))
    definition.evaluation.parameters = { ...(object(definition.evaluation.parameters) ? definition.evaluation.parameters : {}), calibrationReferenceBinding: referenceBinding }
    if (definition.llm.enabled) definition.llm.poolId = state.pools[q.id].id
    const pool = definition.llm.enabled ? pools.find((p: any) => p.id === definition.llm.poolId) : undefined
    const poolBinding = pool ? { poolId: pool.id, revision: pool.revision, name: pool.name, kind: pool.kind,
      model: pool.model, modelVersion: pool.modelVersion, baseUrl: pool.baseUrl,
      credentialEnv: pool.credentialEnv, parameters: pool.parameters } : undefined
    const configurationKey = selfTestConfigurationKey(normalizeDefinition(definition), q.role ?? null, q.category, poolBinding)
    const readCode = (material: CoursePackQuestion['selfTest']) => {
      const data = fs.readFileSync(path.resolve(root, material.codePath))
      if (sha256(data) !== material.codeSha256) throw new Error('reference_code_changed')
      return data.toString('utf8')
    }
    const code = readCode(q.selfTest)
    const opponent = q.selfTest.opponent
    const body = { category: q.category, role: q.role, phase, definition, code,
                   ...(q.selfTest.weightFixture ? { weightFixture: q.selfTest.weightFixture } : {}),
                   ...(phase === 'opponent' && opponent ? { opponent: {
                     code: readCode(opponent),
                     ...(opponent.weightFixture ? { weightFixture: opponent.weightFixture } : {}) } } : {}) }
    return { pkg, configurationKey, body }
  }
  function assertBinding(q: CoursePackQuestion, phase: Phase, id: string, configurationKey: string, record: any) {
    const pkg = state.packages[q.packageKey]
    if (!object(record) || record.id !== id || record.packageId !== pkg.id || record.packageDigest !== pkg.digest ||
        record.phase !== phase || record.configurationKey !== configurationKey) throw new Error('self_test_binding_mismatch')
    if (!['queued', 'running', 'completed'].includes(record.status)) throw new Error('self_test_status_invalid')
  }
  function checkedRecord(q: CoursePackQuestion, phase: Phase, id: string, configurationKey: string, record: any) {
    assertBinding(q, phase, id, configurationKey, record)
    if (record.status !== 'completed') return null
    const lean = leanRecord(record)
    if (lean.result.status !== 'completed' || lean.result.cleanupStatus !== 'cleaned') throw new Error('reference_evaluation_failed_or_not_cleaned')
    if (q.definition.llm.enabled && (!Number.isSafeInteger(record.calls) || record.calls < 1)) throw new Error('real_model_calls_required')
    if (phase === 'basic') {
      if (!Number.isFinite(lean.result.score) || !Number.isFinite(lean.result.maxScore) || lean.result.maxScore! <= 0 || lean.result.score! <= 0 || lean.result.score! > lean.result.maxScore! || lean.result.maxScore !== q.definition.evaluation.maxScore || (q.selfTest.minimumScore !== undefined && lean.result.score! < q.selfTest.minimumScore)) throw new Error('basic_reference_has_no_measured_credit')
    } else if (!Number.isFinite(lean.result.metrics[phase === 'baseline' ? 'qualificationMetric' : 'successMetric'])) throw new Error('required_calibration_metric_missing')
    return lean
  }
  async function run(q: CoursePackQuestion, phase: Phase) {
    const { pkg, configurationKey, body } = contract(q, phase)
    state.tests[q.id] ??= {}
    const proof = state.tests[q.id][phase] ??= {}
    if (proof.configurationKey && proof.configurationKey !== configurationKey) throw new Error('self_test_configuration_changed')
    proof.configurationKey = configurationKey
    if (proof.intent && !proof.id) {
      const recovered = recovery[q.id]?.[phase]
      if (!validTestId(recovered))
        throw new Error('unknown_self_test_outcome_requires_recovery')
      const current = await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${recovered}`)
      assertBinding(q, phase, recovered, configurationKey, current)
      proof.id = recovered
      save()
    }
    if (proof.id && options.retryFailed) {
      if (!validTestId(proof.id)) throw new Error('self_test_id_invalid')
      const old = await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${proof.id}`)
      assertBinding(q, phase, proof.id, configurationKey, old)
      if (old.status === 'completed' && ['student_error', 'system_error', 'timeout'].includes(old.result?.status) && old.result?.cleanupStatus === 'cleaned') {
        proof.failed = [...(proof.failed ?? []), proof.id]
        delete proof.id; delete proof.intent; delete proof.record
        save()
      }
    }
    if (!proof.id) {
      proof.intent = true
      save()
      const created = await request(`/admin/evaluation-packages/${pkg.id}/self-tests`, 'POST', body)
      if (!validTestId(created?.id)) throw new Error('created_self_test_id_invalid')
      proof.id = created.id
      save()
    }
    if (!validTestId(proof.id)) throw new Error('self_test_id_invalid')
    const deadline = Date.now() + (options.selfTestTimeoutMs ?? q.definition.evaluation.timeoutMs + 300000)
    while (true) {
      const record = await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${proof.id}`)
      const checked = checkedRecord(q, phase, proof.id!, configurationKey, record)
      if (checked) {
        proof.record = checked
        save()
        log({ event: 'reference_calibrated', questionId: q.id, phase, metrics: checked.result.metrics, score: checked.result.score })
        return
      }
      if (Date.now() >= deadline) throw new Error('self_test_poll_deadline_exceeded')
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 10000))
    }
  }
  for (const q of selected) {
    for (const phase of (q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']) as Phase[]) await run(q, phase)
  }
  const missing = manifest.questions.filter(q => (q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']).some(phase => !state.tests[q.id]?.[phase as Phase]?.record))
  if (missing.length) return { status: 'partial', remaining: missing.map(q => q.id) }
  const final = structuredClone(manifest)
  const finalPools = await request('/admin/api-pool')
  if (!Array.isArray(finalPools)) throw new Error('invalid_pool_list')
  for (const saved of Object.values(state.pools)) {
    const pool = finalPools.find((p: any) => p.id === saved.id && p.enabled && p.kind === 'llm')
    if (!pool || sha256(JSON.stringify({ id: pool.id, revision: pool.revision, model: pool.model,
        modelVersion: pool.modelVersion, baseUrl: pool.baseUrl, credentialEnv: pool.credentialEnv,
        parameters: pool.parameters })) !== saved.fingerprint)
      throw new Error('model_pool_changed_during_calibration')
  }
  for (const pkg of Object.values(state.packages)) {
    const actual = await request(`/admin/evaluation-packages/${pkg.id}/validate`, 'POST')
    if (actual.id !== pkg.id || actual.digest !== pkg.digest || actual.valid !== true || actual.manifest?.image !== evidence.image)
      throw new Error('installed_package_changed')
  }
  for (const q of final.questions) {
    const proofs = state.tests[q.id]
    for (const phase of (q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']) as Phase[]) {
      const proof = proofs[phase]
      const pkg = state.packages[q.packageKey]
      if (!proof?.id || !proof.configurationKey) throw new Error('final_proof_missing')
      if (pkg.digest !== expectedPackages[q.packageKey]) throw new Error('installed_package_changed')
      const expected = contract(q, phase)
      if (proof.configurationKey !== expected.configurationKey) throw new Error('self_test_configuration_changed')
      const current = await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${proof.id}`)
      const checked = checkedRecord(q, phase, proof.id, expected.configurationKey, current)
      if (!checked) throw new Error('final_proof_not_current_and_clean')
      proof.record = checked
    }
    if (q.category === 'basic') {
      const result = proofs.basic!.record.result
      if (!Number.isFinite(result.score) || result.score <= 0) throw new Error('basic_reference_has_no_measured_credit')
    } else {
      const metadata = evidence.questions.find((r: any) => r.sourceId === q.id.replace('V3-261012-', ''))
      const baseline = proofs.baseline!.record.result.metrics.qualificationMetric
      const success = proofs.opponent!.record.result.metrics.successMetric
      const selectedThresholds = thresholds(baseline, success, metadata?.minimumPositiveSuccessThreshold)
      Object.assign(q.definition.evaluation, selectedThresholds)
      if (q.definition.evaluation.parameters && typeof q.definition.evaluation.parameters === 'object')
        Object.assign(q.definition.evaluation.parameters, { successThreshold: selectedThresholds.successThreshold })
    }
    delete q.definition.evaluation.calibrationMode
    if (object(q.definition.evaluation.parameters)) {
      delete q.definition.evaluation.parameters.calibrationMode
      delete q.definition.evaluation.parameters.calibrationReferenceBinding
    }
    if (q.definition.llm.enabled) q.definition.llm.poolId = state.pools[q.id].id
    q.requiresCalibration = false
    q.deploymentReady = true
  }
  final.requiresCalibration = false
  final.deploymentReady = true
  // Long-running real model/training calibration must not certify files that
  // changed after the initial preflight or advertise a different floor rule.
  if (loadCoursePack(path.resolve(options.manifest)).manifestDigest !== manifestDigest ||
      sha256(fs.readFileSync(options.evidence)) !== evidenceDigest) throw new Error('calibration_input_changed')
  save()
  if (fs.existsSync(options.output)) throw new Error('final_manifest_already_exists')
  fs.writeFileSync(options.output, JSON.stringify(final, null, 2), { flag: 'wx' })
  return { status: 'calibrated', questions: 77, output: options.output }
  } finally {
    fs.closeSync(lock)
    fs.unlinkSync(statePath + '.lock')
  }
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, evidence: { type: 'string' }, state: { type: 'string' },
    output: { type: 'string' }, api: { type: 'string' }, 'token-file': { type: 'string' }, 'pool-map': { type: 'string' },
    only: { type: 'string' }, recover: { type: 'string' }, 'retry-failed': { type: 'boolean', default: false } } })
  for (const name of ['manifest', 'evidence', 'state', 'output', 'api', 'token-file'] as const)
    if (!values[name]) throw new Error('required_argument_missing')
  console.log(JSON.stringify(await calibrate({ manifest: values.manifest!, evidence: values.evidence!, state: values.state!,
    output: values.output!, api: values.api!, tokenFile: values['token-file']!, poolMap: values['pool-map'],
    only: values.only?.split(','), recover: values.recover, retryFailed: values['retry-failed'] })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { console.error('Course calibration stopped; inspect the saved state and private evaluation logs.'); process.exitCode = 1 })
