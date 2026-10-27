/** Reference calibration creates only immutable packages and their self-tests.
 * No Question, Submission, score or leaderboard rows are changed here.
 * The final manifest is written only after all 77 real Docker evaluations pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import AdmZip from 'adm-zip'
import { loadCoursePack, sha256, type CoursePackQuestion, type CoursePackManifest } from './importCoursePackV3.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import { decodeEvaluationArchive } from '../src/lib/evaluationPackage.js'
import { snapshotCallEvidence } from '../src/services/modelResponseSnapshot.js'

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
  poolMap?: string; only?: string[]; recover?: string; retryFailed?: boolean; concurrency?: number;
  refreshFrom?: string; refreshManifest?: string; refreshEvidence?: string;
  pollMs?: number; selfTestTimeoutMs?: number; log?: (event: any) => void }
interface State { manifestDigest: string; evidenceDigest: string; api: string; packages: Record<string, any>;
  pools: Record<string, any>; tests: Record<string, Partial<Record<Phase, Proof>>>;
  references?: Record<string, { referenceManifestDigest: string; questionDigest: string; packageFilesDigest: string }>;
  refreshFrom?: { stateDigest: string; manifestDigest: string; evidenceDigest: string } }
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const validTestId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const validDigest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const phases = (q: CoursePackQuestion): Phase[] => q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']
const jsonDigest = (value: unknown) => sha256(JSON.stringify(value))
function fields(value: any, names: string[]) { return object(value) && Object.keys(value).every(key => names.includes(key)) }
export function packageArchive(root: string, pkg: CoursePackManifest['packages'][number]) {
  const zip = new AdmZip()
  for (const file of [...pkg.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const data = fs.readFileSync(path.resolve(root, pkg.directory, file.path))
    if (sha256(data) !== file.sha256) throw new Error('package_input_changed')
    zip.addFile(file.path, data)
  }
  const bytes = zip.toBuffer()
  return { bytes, digest: jsonDigest(Object.fromEntries([...decodeEvaluationArchive(bytes)].map(([name, data]) => [name, sha256(data)]))) }
}
function validateImages(manifest: CoursePackManifest, root: string, image: string) {
  for (const pkg of manifest.packages)
    if (JSON.parse(fs.readFileSync(path.resolve(root, pkg.directory, 'manifest.json'), 'utf8')).image !== image)
      throw new Error('package_source_image_mismatch')
}
function validateEvidenceScope(evidence: any, manifest: CoursePackManifest) {
  const expected = new Set(manifest.questions.map(q => q.id.replace('V3-261012-', '')))
  if (!object(evidence) || !Array.isArray(evidence.questions) || evidence.questions.length !== expected.size ||
      evidence.questions.some((q: any) => !object(q) || !expected.delete(q.sourceId)) || expected.size)
    throw new Error('refresh_evidence_scope_invalid')
}
function validateRefreshState(state: State, manifest: CoursePackManifest, root: string) {
  const fail = () => { throw new Error('refresh_source_state_invalid') }
  if (!fields(state, ['manifestDigest', 'evidenceDigest', 'api', 'packages', 'pools', 'tests', 'references', 'refreshFrom']) ||
      !validDigest(state.manifestDigest) || !validDigest(state.evidenceDigest) || typeof state.api !== 'string' ||
      !object(state.packages) || !object(state.pools) || !object(state.tests)) fail()
  for (const [key, saved] of Object.entries(state.packages)) {
    const pkg = manifest.packages.find(p => p.key === key)
    if (!pkg || !fields(saved, ['id', 'digest', 'inputDigest']) || !validId(saved.id) ||
        saved.inputDigest !== jsonDigest(pkg.files) || saved.digest !== packageArchive(root, pkg).digest) fail()
  }
  for (const [id, pool] of Object.entries(state.pools)) {
    const q = manifest.questions.find(q => q.id === id)
    if (!q?.definition.llm.enabled || !fields(pool, ['id', 'fingerprint', 'revision', 'model', 'modelVersion']) ||
        !validId(pool.id) || !validDigest(pool.fingerprint) || !Number.isSafeInteger(pool.revision) || pool.revision < 1 ||
        typeof pool.model !== 'string' || !pool.model || typeof pool.modelVersion !== 'string' || !pool.modelVersion) fail()
  }
  const ids = new Set<string>()
  for (const [id, proofs] of Object.entries(state.tests)) {
    const q = manifest.questions.find(q => q.id === id)
    if (!q || !object(proofs) || !state.packages[q.packageKey] || q.definition.llm.enabled && !state.pools[id]) fail()
    for (const [phase, proof] of Object.entries(proofs)) {
      if (!phases(q!).includes(phase as Phase) || !fields(proof, ['intent', 'id', 'configurationKey', 'record', 'failed']) ||
          !validDigest(proof.configurationKey) || proof.intent !== undefined && proof.intent !== true ||
          proof.id !== undefined && (!validTestId(proof.id) || ids.has(proof.id)) ||
          proof.failed !== undefined && (!Array.isArray(proof.failed) || proof.failed.some((id: unknown) => !validTestId(id)) || new Set(proof.failed).size !== proof.failed.length || proof.id !== undefined && proof.failed.includes(proof.id))) fail()
      if (proof.id) ids.add(proof.id)
      if (proof.record !== undefined) {
        const record = proof.record, pkg = state.packages[q!.packageKey]
        if (!proof.id || !fields(record, ['id', 'packageId', 'packageDigest', 'phase', 'configurationKey', 'status', 'calls', 'upstreamCalls', 'responseSnapshotHits', 'result']) ||
            record.id !== proof.id || record.packageId !== pkg.id || record.packageDigest !== pkg.digest || record.phase !== phase ||
            record.configurationKey !== proof.configurationKey || record.status !== 'completed' ||
            record.result?.status !== 'completed' || record.result?.cleanupStatus !== 'cleaned' ||
            JSON.stringify(leanRecord(record)) !== JSON.stringify(record)) fail()
      }
    }
  }
  if ((state.references === undefined) !== (state.refreshFrom === undefined)) fail()
  if (state.refreshFrom !== undefined) {
    if (!fields(state.refreshFrom, ['stateDigest', 'manifestDigest', 'evidenceDigest']) ||
        !Object.values(state.refreshFrom).every(validDigest) || !object(state.references)) fail()
    for (const [id, reference] of Object.entries(state.references!)) {
      const q = manifest.questions.find(q => q.id === id)
      const pkg = q && manifest.packages.find(p => p.key === q.packageKey)
      if (!q || !pkg || !fields(reference, ['referenceManifestDigest', 'questionDigest', 'packageFilesDigest']) ||
          !validDigest(reference.referenceManifestDigest) || reference.questionDigest !== jsonDigest(q) ||
          reference.packageFilesDigest !== jsonDigest(pkg.files)) fail()
    }
  }
}
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
    ...(record.upstreamCalls !== undefined || record.responseSnapshotHits !== undefined ? snapshotCallEvidence(record) : {}),
    result: { status: result.status, cleanupStatus: result.cleanupStatus, metrics,
      ...(typeof result.score === 'number' ? { score: result.score } : {}),
      ...(typeof result.maxScore === 'number' ? { maxScore: result.maxScore } : {}) } }
}

export async function calibrate(options: Options) {
  const concurrency = options.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('calibration_concurrency_must_be_integer_1_to_4')
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
  const refresh = [options.refreshFrom, options.refreshManifest, options.refreshEvidence]
  if (refresh.some(Boolean) && !refresh.every(Boolean)) throw new Error('refresh_requires_all_source_inputs')
  if ([options.manifest, options.evidence, options.output, options.tokenFile, options.poolMap, options.recover, ...refresh].filter(Boolean).some(file => path.resolve(file!) === statePath)) throw new Error('state_path_conflicts_with_input')
  if (options.refreshFrom && fs.existsSync(statePath)) throw new Error('refresh_target_state_already_exists')
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  let lock: number
  try { lock = fs.openSync(statePath + '.lock', 'wx', 0o600) } catch { throw new Error('calibration_state_locked') }
  let sourceLock: number | undefined
  let source: { state: State; manifest: CoursePackManifest; root: string; manifestDigest: string; stateDigest: string; evidenceDigest: string } | undefined
  try {
  if (options.refreshFrom) {
    if (fs.existsSync(statePath)) throw new Error('refresh_target_state_already_exists')
    try { sourceLock = fs.openSync(path.resolve(options.refreshFrom) + '.lock', 'wx', 0o600) } catch { throw new Error('refresh_source_state_locked') }
    if (!fs.lstatSync(options.refreshFrom).isFile()) throw new Error('refresh_source_state_invalid')
    const previous = loadCoursePack(path.resolve(options.refreshManifest!))
    const oldEvidenceBytes = fs.readFileSync(options.refreshEvidence!)
    const oldEvidence = JSON.parse(oldEvidenceBytes.toString('utf8'))
    if (!Array.isArray(oldEvidence.questions) || oldEvidence.image !== evidence.image ||
        previous.manifest.packId !== manifest.packId || previous.manifest.sourceArchiveSha256 !== manifest.sourceArchiveSha256)
      throw new Error('refresh_source_identity_changed')
    validateEvidenceScope(oldEvidence, previous.manifest)
    validateEvidenceScope(evidence, manifest)
    validateImages(previous.manifest, previous.root, oldEvidence.image)
    validateImages(manifest, root, evidence.image)
    const bytes = fs.readFileSync(options.refreshFrom)
    const oldState = JSON.parse(bytes.toString('utf8')) as State
    validateRefreshState(oldState, previous.manifest, previous.root)
    if (oldState.manifestDigest !== previous.manifestDigest || oldState.evidenceDigest !== sha256(oldEvidenceBytes) || oldState.api !== options.api)
      throw new Error('refresh_source_input_changed')
    source = { ...previous, state: oldState, stateDigest: sha256(bytes), evidenceDigest: sha256(oldEvidenceBytes) }
  }
  const state: State =
    fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) :
    { manifestDigest, evidenceDigest, api: options.api, packages: {}, pools: {}, tests: {} }
  if (state.manifestDigest !== manifestDigest || state.evidenceDigest !== evidenceDigest || state.api !== options.api)
    throw new Error('calibration_input_changed')
  if (!object(state.packages) || !object(state.pools) || !object(state.tests) ||
      Object.values(state.packages).some(p => !object(p) || !validId(p.id))) throw new Error('calibration_state_invalid')
  if (state.refreshFrom || state.references) validateRefreshState(state, manifest, root)
  if (source) {
    state.refreshFrom = { stateDigest: source.stateDigest, manifestDigest: source.manifestDigest, evidenceDigest: source.evidenceDigest }
    state.references = {}
    for (const q of manifest.questions) {
      const old = source.manifest.questions.find(row => row.id === q.id)!
      const pkg = manifest.packages.find(p => p.key === q.packageKey)!
      const oldPkg = source.manifest.packages.find(p => p.key === old.packageKey)!
      if (JSON.stringify(q) !== JSON.stringify(old) || JSON.stringify(pkg.files) !== JSON.stringify(oldPkg.files)) continue
      state.references[q.id] = { referenceManifestDigest: source.state.references?.[q.id]?.referenceManifestDigest ?? source.manifestDigest,
        questionDigest: jsonDigest(q), packageFilesDigest: jsonDigest(pkg.files) }
      if (source.state.tests[q.id]) state.tests[q.id] = structuredClone(source.state.tests[q.id])
      if (source.state.pools[q.id]) state.pools[q.id] = structuredClone(source.state.pools[q.id])
      if (source.state.packages[q.packageKey]) state.packages[q.packageKey] = structuredClone(source.state.packages[q.packageKey])
    }
  }
  const save = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(statePath + '.tmp', statePath)
  }
  const log = options.log ?? ((item) => console.log(JSON.stringify(item)))
  const api = new URL(options.api)
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || !/\/api\/?$/.test(api.pathname))
    throw new Error('invalid_api_url')
  async function request(route: string, method = 'GET', body?: any) {
    const token = fs.readFileSync(options.tokenFile, 'utf8').trim()
    if (token.length < 16 || /\s/.test(token)) throw new Error('invalid_token_file')
    let response: Response
    try {
      response = await fetch(options.api.replace(/\/$/, '') + route, { method,
        // Synchronous archive work can outlive the server's idle timeout while
        // blocking FIN processing. Never reuse that socket for a mutation.
        headers: { Authorization: `Bearer ${token}`, Connection: 'close', ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
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
  if (source) {
    // Validate every source pool and proof scope, including discarded questions.
    // A refresh cannot launder a corrupt state by selecting a different subset.
    for (const saved of Object.values(source.state.pools)) {
      const pool = pools.find((p: any) => p.id === saved.id && p.enabled && p.kind === 'llm')
      const frozen = pool && { id: pool.id, revision: pool.revision, model: pool.model, modelVersion: pool.modelVersion,
        baseUrl: pool.baseUrl, credentialEnv: pool.credentialEnv, parameters: pool.parameters }
      if (!pool || jsonDigest(frozen) !== saved.fingerprint || pool.revision !== saved.revision || pool.model !== saved.model || pool.modelVersion !== saved.modelVersion)
        throw new Error('refresh_source_model_pool_changed')
    }
    for (const [id, proofs] of Object.entries(source.state.tests)) {
      const q = source.manifest.questions.find(q => q.id === id)!
      for (const [phase, proof] of Object.entries(proofs)) {
        if (proof.configurationKey !== contract(q, phase as Phase, source).configurationKey) throw new Error('refresh_source_proof_binding_mismatch')
        if (proof.record) checkedRecord(q, phase as Phase, proof.id!, proof.configurationKey!, proof.record, source.state)
      }
    }
    for (const [id, saved] of Object.entries(state.pools)) {
      const q = manifest.questions.find(q => q.id === id)!
      if (saved.id !== (poolMap[id] ?? q.definition.llm.poolId)) throw new Error('refresh_model_pool_selection_changed')
    }
  }
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
  validateImages(manifest, root, evidence.image)
  // The inventory API verifies every historical archive synchronously. A
  // fully bound resume needs only its original per-package validations below.
  // Query inventory lazily only to reconcile a new/uncertain package upload.
  let installedPackages: any[] | undefined
  for (const pkg of manifest.packages) {
    const { bytes, digest: expectedDigest } = packageArchive(root, pkg)
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
      if (!installedPackages) {
        const available = await request('/admin/evaluation-packages')
        if (!Array.isArray(available)) throw new Error('invalid_package_list')
        installedPackages = available
      }
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
  function contract(q: CoursePackQuestion, phase: Phase, context = { state, manifest, root, manifestDigest }) {
    const pkg = context.state.packages[q.packageKey]
    const definition = structuredClone(q.definition)
    definition.evaluation = { ...definition.evaluation, packageId: pkg.id, calibrationMode: true,
                              baselineThreshold: 0, successThreshold: 1 }
    const fixtureDigest = (fixture?: string) => fixture ? context.manifest.packages.find(p => p.key === q.packageKey)!.files.find(f => f.path === fixture)!.sha256 : null
    const referenceBinding = sha256(JSON.stringify({ manifestDigest: context.state.references?.[q.id]?.referenceManifestDigest ?? context.manifestDigest, questionId: q.id, phase,
      code: q.selfTest.codeSha256, weights: fixtureDigest(q.selfTest.weightFixture),
      opponentCode: phase === 'opponent' ? q.selfTest.opponent?.codeSha256 : null,
      opponentWeights: phase === 'opponent' ? fixtureDigest(q.selfTest.opponent?.weightFixture) : null }))
    definition.evaluation.parameters = { ...(object(definition.evaluation.parameters) ? definition.evaluation.parameters : {}), calibrationReferenceBinding: referenceBinding }
    if (definition.llm.enabled) definition.llm.poolId = context.state.pools[q.id].id
    const pool = definition.llm.enabled ? pools.find((p: any) => p.id === definition.llm.poolId) : undefined
    const poolBinding = pool ? { poolId: pool.id, revision: pool.revision, name: pool.name, kind: pool.kind,
      model: pool.model, modelVersion: pool.modelVersion, baseUrl: pool.baseUrl,
      credentialEnv: pool.credentialEnv, parameters: pool.parameters } : undefined
    const configurationKey = selfTestConfigurationKey(normalizeDefinition(definition), q.role ?? null, q.category, poolBinding)
    const readCode = (material: CoursePackQuestion['selfTest']) => {
      const data = fs.readFileSync(path.resolve(context.root, material.codePath))
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
  function assertBinding(q: CoursePackQuestion, phase: Phase, id: string, configurationKey: string, record: any, boundState = state) {
    const pkg = boundState.packages[q.packageKey]
    if (!object(record) || record.id !== id || record.packageId !== pkg.id || record.packageDigest !== pkg.digest ||
        record.phase !== phase || record.configurationKey !== configurationKey) throw new Error('self_test_binding_mismatch')
    if (!['queued', 'running', 'completed'].includes(record.status)) throw new Error('self_test_status_invalid')
  }
  function checkedRecord(q: CoursePackQuestion, phase: Phase, id: string, configurationKey: string, record: any, boundState = state) {
    assertBinding(q, phase, id, configurationKey, record, boundState)
    if (record.status !== 'completed') return null
    const lean = leanRecord(record)
    if (lean.result.status !== 'completed' || lean.result.cleanupStatus !== 'cleaned') throw new Error('reference_evaluation_failed_or_not_cleaned')
    if (q.definition.llm.enabled && (!Number.isSafeInteger(record.calls) || record.calls < 1)) throw new Error('real_model_calls_required')
    if ((q.definition.evaluation.parameters as any)?.responseSnapshotPolicy !== undefined) snapshotCallEvidence(record)
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
  // State writes remain synchronous under the existing exclusive state lock.
  // Workers own distinct question proofs; each question keeps its phase order.
  // On failure, finish already-started questions and persist their evidence
  // before releasing the lock. Promise.all must never reject early here.
  let nextQuestion = 0, failed = false
  let firstError: unknown
  async function worker() {
    while (!failed && nextQuestion < selected.length) {
      const q = selected[nextQuestion++]
      try {
        for (const phase of (q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']) as Phase[]) await run(q, phase)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()))
  if (failed) throw firstError
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
    if (sourceLock !== undefined) { fs.closeSync(sourceLock); fs.unlinkSync(path.resolve(options.refreshFrom!) + '.lock') }
    fs.closeSync(lock)
    fs.unlinkSync(statePath + '.lock')
  }
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, evidence: { type: 'string' }, state: { type: 'string' },
    output: { type: 'string' }, api: { type: 'string' }, 'token-file': { type: 'string' }, 'pool-map': { type: 'string' },
    only: { type: 'string' }, recover: { type: 'string' }, 'retry-failed': { type: 'boolean', default: false },
    'refresh-from': { type: 'string' }, 'refresh-manifest': { type: 'string' }, 'refresh-evidence': { type: 'string' },
    concurrency: { type: 'string', default: '1' } } })
  for (const name of ['manifest', 'evidence', 'state', 'output', 'api', 'token-file'] as const)
    if (!values[name]) throw new Error('required_argument_missing')
  console.log(JSON.stringify(await calibrate({ manifest: values.manifest!, evidence: values.evidence!, state: values.state!,
    output: values.output!, api: values.api!, tokenFile: values['token-file']!, poolMap: values['pool-map'],
    only: values.only?.split(','), recover: values.recover, retryFailed: values['retry-failed'], concurrency: Number(values.concurrency),
    refreshFrom: values['refresh-from'], refreshManifest: values['refresh-manifest'], refreshEvidence: values['refresh-evidence'] })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { console.error('Course calibration stopped; inspect the saved state and private evaluation logs.'); process.exitCode = 1 })
