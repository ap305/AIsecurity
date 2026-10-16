/**
 * Explicit, resumable HTTP import of the V3-261012 course pack. No DB/seed imports.
 * Local files are data, never executed. --dry-run performs no HTTP or writes.
 * --stage prepare|self-test|publish|verify|all --manifest FILE --api URL
 * --token-file FILE --state FILE --resources-root DIR [--only ID,ID]
 * Optional --pool-bindings FILE: {llm?: poolId, teacher?: poolId}.
 * Unknown self-test POST outcomes stop safely; --recover-self-tests FILE can bind
 * {questionId: {phase: testId}} after independently identifying the created test.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import AdmZip from 'adm-zip'
import { normalizeDefinition, type QuestionDefinition, type PoolBinding } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import { ARCHIVE_LIMITS, decodeEvaluationArchive, safeRelativeName } from '../src/lib/evaluationPackage.js'

export const COURSE_PACK_IDS = [
  ...Array.from({ length: 17 }, (_, n) => `V3-261012-B${String(n + 1).padStart(2, '0')}`),
  ...['A', 'D'].flatMap((role) => Array.from({ length: 31 }, (_, n) => n + 1)
    .filter((n) => n !== 29).map((n) => `V3-261012-${role}${String(n).padStart(2, '0')}`)),
]
type Phase = 'basic' | 'baseline' | 'opponent'
type Stage = 'prepare' | 'self-test' | 'publish' | 'verify' | 'all'
export interface CoursePackFile { path: string; sha256: string }
export interface CoursePackMaterial { codePath: string; codeSha256: string; weightFixture?: string }
export interface CoursePackQuestion {
  requiresCalibration?: boolean
  deploymentReady?: boolean
  id: string
  title: string
  moduleCode: string
  number: number
  difficulty: string
  category: 'basic' | 'adversarial'
  scenarioId?: string
  role?: 'attack' | 'defense'
  content: string
  answerTemplate: string
  definition: QuestionDefinition
  packageKey: string
  selfTest: CoursePackMaterial & { opponent?: CoursePackMaterial; minimumScore?: number }
  resources: Array<{ sourcePath: string; filename: string; sha256: string }>
}
export interface CoursePackManifest {
  requiresCalibration?: boolean
  deploymentReady?: boolean
  schemaVersion: 1
  packId: 'V3-261012'
  sourceArchiveSha256: string
  packages: Array<{ key: string; directory: string; files: CoursePackFile[] }>
  questions: CoursePackQuestion[]
}
export interface ImportOptions {
  manifest: string
  api?: string
  tokenFile?: string
  stateFile?: string
  resourcesRoot?: string
  stage?: Stage
  dryRun?: boolean
  only?: string[]
  poolBindings?: { llm?: string; teacher?: string }
  recoverSelfTests?: Record<string, Partial<Record<Phase, string>>>
  retryFailed?: boolean
  pollMs?: number
  concurrency?: number
  log?: (event: Record<string, unknown>) => void
}
class ImportError extends Error {
  constructor(public reason: string) { super(reason) }
}
function requireThat(value: unknown, reason: string): asserts value {
  if (!value) throw new ImportError(reason)
}
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function object(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: any, allowed: string[], reason: string) {
  requireThat(object(value) && Object.keys(value).every((key) => allowed.includes(key)), reason)
}
function digest(value: unknown) { requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid_sha256') }
function relative(value: unknown): string {
  requireThat(typeof value === 'string', 'invalid_relative_path')
  try { return safeRelativeName(value) } catch { throw new ImportError('unsafe_relative_path') }
}
function noLinks(file: string) {
  let cursor = path.resolve(file)
  while (true) {
    if (fs.existsSync(cursor)) requireThat(!fs.lstatSync(cursor).isSymbolicLink(), 'symlink_not_allowed')
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}
function inputFile(root: string, name: string, expected?: string, maxBytes = 512 * 1024 * 1024) {
  const filename = path.resolve(root, relative(name))
  requireThat(filename.startsWith(root + path.sep), 'input_escaped_manifest_root')
  noLinks(filename)
  requireThat(fs.existsSync(filename) && fs.statSync(filename).isFile(), 'input_file_missing')
  requireThat(fs.statSync(filename).size <= maxBytes, 'input_file_too_large')
  const bytes = fs.readFileSync(filename)
  if (expected) requireThat(sha256(bytes) === expected, 'input_digest_mismatch')
  return bytes
}
function readCode(root: string, material: CoursePackMaterial) {
  const bytes = inputFile(root, material.codePath, material.codeSha256, 1024 * 1024)
  const code = bytes.toString('utf8')
  requireThat(code.trim() && Buffer.from(code).equals(bytes), 'reference_code_invalid_utf8')
  return code
}
function packageFiles(root: string, item: CoursePackManifest['packages'][number]) {
  const directory = path.resolve(root, relative(item.directory))
  noLinks(directory)
  requireThat(fs.existsSync(directory) && fs.statSync(directory).isDirectory(), 'package_directory_missing')
  const actual: string[] = []
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      requireThat(!entry.isSymbolicLink(), 'package_link_not_allowed')
      if (entry.isDirectory()) walk(path.join(folder, entry.name))
      else {
        requireThat(entry.isFile(), 'package_special_file_not_allowed')
        actual.push(path.relative(directory, path.join(folder, entry.name)).split(path.sep).join('/'))
      }
    }
  }
  walk(directory)
  requireThat(canonical(actual.sort()) === canonical(item.files.map((file) => file.path).sort()), 'package_files_not_exactly_allowlisted')
  let total = 0
  for (const file of item.files) {
    const bytes = inputFile(directory, file.path, file.sha256, ARCHIVE_LIMITS.fileBytes)
    total += bytes.length
  }
  requireThat(total <= ARCHIVE_LIMITS.expandedBytes, 'package_expanded_size_exceeded')
  return directory
}

export function loadCoursePack(manifestFile: string): { manifest: CoursePackManifest; root: string; manifestDigest: string } {
  noLinks(manifestFile)
  requireThat(fs.statSync(manifestFile).size <= 64 * 1024 * 1024, 'manifest_too_large')
  let manifest: CoursePackManifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw new ImportError('manifest_json_invalid') }
  keys(manifest, ['schemaVersion', 'packId', 'sourceArchiveSha256', 'packages', 'questions', 'requiresCalibration', 'deploymentReady'], 'manifest_fields_invalid')
  requireThat([manifest.requiresCalibration, manifest.deploymentReady].every((v) => v === undefined || typeof v === 'boolean'), 'manifest_readiness_flag_invalid')
  requireThat(manifest.schemaVersion === 1 && manifest.packId === 'V3-261012', 'manifest_identity_invalid')
  digest(manifest.sourceArchiveSha256)
  requireThat(Array.isArray(manifest.questions) && manifest.questions.length === 77, 'manifest_requires_all_77_questions')
  requireThat(canonical(manifest.questions.map((q) => q.id).sort()) === canonical([...COURSE_PACK_IDS].sort()), 'question_scope_invalid')
  requireThat(Array.isArray(manifest.packages) && manifest.packages.length > 0 && manifest.packages.length <= 77, 'package_scope_invalid')
  const root = path.resolve(path.dirname(manifestFile))
  const packageKeys = new Set<string>()
  for (const item of manifest.packages) {
    keys(item, ['key', 'directory', 'files'], 'package_fields_invalid')
    requireThat(typeof item.key === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.key) && !packageKeys.has(item.key), 'package_key_invalid_or_duplicate')
    packageKeys.add(item.key)
    requireThat(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= ARCHIVE_LIMITS.entries, 'package_file_count_invalid')
    const names = new Set<string>()
    for (const file of item.files) {
      keys(file, ['path', 'sha256'], 'package_file_fields_invalid')
      relative(file.path); digest(file.sha256)
      requireThat(!names.has(file.path.toLowerCase()), 'duplicate_package_file')
      names.add(file.path.toLowerCase())
    }
    requireThat(names.has('manifest.json') && names.has('compose.yaml'), 'package_manifest_or_compose_missing')
    packageFiles(root, item)
  }
  for (const q of manifest.questions) {
    keys(q, ['id', 'title', 'moduleCode', 'number', 'difficulty', 'category', 'scenarioId', 'role', 'content', 'answerTemplate', 'definition', 'packageKey', 'selfTest', 'resources', 'requiresCalibration', 'deploymentReady'], 'question_fields_invalid')
    requireThat([q.requiresCalibration, q.deploymentReady].every((v) => v === undefined || typeof v === 'boolean'), 'question_readiness_flag_invalid')
    requireThat([q.title, q.moduleCode, q.difficulty, q.content].every((v) => typeof v === 'string' && v.trim()) && typeof q.answerTemplate === 'string', 'question_text_invalid')
    requireThat(Number.isSafeInteger(q.number) && q.number > 0 && packageKeys.has(q.packageKey), 'question_number_or_package_invalid')
    const basic = q.id.startsWith('V3-261012-B')
    requireThat(q.category === (basic ? 'basic' : 'adversarial'), 'question_category_invalid')
    requireThat(basic ? !q.role && !q.scenarioId : q.role === (q.id.startsWith('V3-261012-A') ? 'attack' : 'defense') && typeof q.scenarioId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(q.scenarioId), 'question_role_or_scenario_invalid')
    requireThat(object(q.definition) && !q.definition.evaluation?.packageId && !q.definition.evaluation?.packageDigest && !q.definition.evaluation?.calibrationMode, 'definition_must_not_bind_package_or_calibration')
    requireThat(Number.isFinite(q.definition.evaluation?.baselineThreshold) && Number.isFinite(q.definition.evaluation?.successThreshold), 'thresholds_must_be_explicit_finite_numbers')
    let normalized: QuestionDefinition
    try { normalized = normalizeDefinition(q.definition) } catch { throw new ImportError('question_definition_invalid') }
    requireThat(!basic || normalized.evaluation.maxScore > 0, 'basic_score_invalid')
    keys(q.selfTest, ['codePath', 'codeSha256', 'weightFixture', 'opponent', 'minimumScore'], 'self_test_fields_invalid')
    const pkg = manifest.packages.find((p) => p.key === q.packageKey)!
    const validateMaterial = (material: CoursePackMaterial) => {
      relative(material.codePath); digest(material.codeSha256); readCode(root, material)
      if (material.weightFixture !== undefined) {
        requireThat(relative(material.weightFixture).startsWith('fixtures/') && pkg.files.some((file) => file.path === material.weightFixture), 'weight_fixture_missing_or_not_private')
      }
    }
    validateMaterial(q.selfTest)
    requireThat(!normalized.weights.required || q.selfTest.weightFixture, 'reference_weights_required')
    if (!basic) {
      requireThat(q.selfTest.opponent, 'opponent_reference_required')
      keys(q.selfTest.opponent, ['codePath', 'codeSha256', 'weightFixture'], 'opponent_fields_invalid')
      validateMaterial(q.selfTest.opponent)
      const otherId = q.id.replace(/-(A|D)(\d+)$/, (_s, role, n) => `-${role === 'A' ? 'D' : 'A'}${n}`)
      const other = manifest.questions.find((row) => row.id === otherId)!
      requireThat(other.scenarioId === q.scenarioId && other.definition?.evaluation?.version === q.definition.evaluation.version, 'arena_pair_contract_mismatch')
    } else requireThat(!q.selfTest.opponent, 'basic_question_cannot_have_opponent')
    if (q.selfTest.minimumScore !== undefined) requireThat(basic && Number.isFinite(q.selfTest.minimumScore) && q.selfTest.minimumScore >= 0 && q.selfTest.minimumScore <= normalized.evaluation.maxScore, 'minimum_self_test_score_invalid')
    requireThat(Array.isArray(q.resources), 'resources_must_be_explicit')
    const names = new Set<string>()
    for (const resource of q.resources) {
      keys(resource, ['sourcePath', 'filename', 'sha256'], 'resource_fields_invalid')
      const filename = relative(resource.filename)
      requireThat(!filename.includes('/') && !filename.includes('..') && !names.has(filename.toLowerCase()), 'resource_filename_invalid_or_duplicate')
      names.add(filename.toLowerCase()); digest(resource.sha256)
      inputFile(root, resource.sourcePath, resource.sha256)
    }
  }
  return { manifest, root, manifestDigest: sha256(canonical(manifest)) }
}

type TestProof = { intent?: boolean; id?: string; configurationKey: string; materialDigest: string; result?: { status: string; cleanupStatus: string; score?: number; metric?: number }; failed?: string[] }
type QuestionState = { marker: string; created?: boolean; prepared?: boolean; published?: { revision: number; updatedAt: string }; tests: Partial<Record<Phase, TestProof>> }
type ImportState = { schemaVersion: 1; packId: string; target: string; manifestDigest: string; bindingsDigest: string; resourcesRootDigest: string; createdAt: string; updatedAt: string; packages: Record<string, { id: string; digest: string }>; questions: Record<string, QuestionState>; poolDigests: Record<string, string> }

export async function importCoursePack(options: ImportOptions) {
  const loaded = loadCoursePack(path.resolve(options.manifest)), { manifest, root, manifestDigest } = loaded
  const stage = options.stage || 'prepare'
  requireThat(['prepare', 'self-test', 'publish', 'verify', 'all'].includes(stage), 'stage_invalid')
  if (['all', 'publish', 'verify'].includes(stage)) {
    requireThat(!manifest.requiresCalibration && manifest.deploymentReady !== false && manifest.questions.every((q) =>
      !q.requiresCalibration && q.deploymentReady !== false && !(object(q.definition.evaluation.parameters) && q.definition.evaluation.parameters.calibrationMode === true)),
    'course_pack_not_calibrated_or_deployment_ready')
  }
  const selected = new Set(options.only || COURSE_PACK_IDS)
  requireThat(selected.size > 0 && selected.size === (options.only?.length ?? 77) && [...selected].every((id) => COURSE_PACK_IDS.includes(id)), 'selected_scope_invalid')
  const rows = manifest.questions.filter((q) => selected.has(q.id))
  const bindings = options.poolBindings || {}
  keys(bindings, ['llm', 'teacher'], 'pool_binding_fields_invalid')
  requireThat(Object.values(bindings).every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)), 'pool_binding_id_invalid')
  const boundDefinition = (q: CoursePackQuestion, packageId?: string, packageDigest?: string) => {
    const raw = structuredClone(q.definition)
    if (raw.llm?.poolId === '$llm') raw.llm.poolId = bindings.llm
    if (raw.teacherApi?.poolId === '$teacher') raw.teacherApi.poolId = bindings.teacher
    if (packageId) raw.evaluation.packageId = packageId
    if (packageDigest) raw.evaluation.packageDigest = packageDigest
    try { return normalizeDefinition(raw) } catch { throw new ImportError('runtime_pool_binding_missing') }
  }
  // Dry-run permits placeholders so builders can check a complete pack before deployment bindings exist.
  const plan = { schemaVersion: 1, packId: manifest.packId, manifestDigest, stage, dryRun: !!options.dryRun, totalManifestQuestions: 77, selectedQuestions: rows.map((q) => q.id), basicQuestions: rows.filter((q) => q.category === 'basic').length, adversarialQuestions: rows.filter((q) => q.category === 'adversarial').length, resourceFiles: rows.reduce((n, q) => n + q.resources.length, 0) }
  if (options.dryRun) return { ...plan, status: 'validated', writes: 0, httpRequests: 0 }
  requireThat(options.api && options.tokenFile && options.stateFile && options.resourcesRoot, 'required_options_missing')
  const url = new URL(options.api)
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && /\/api\/?$/.test(url.pathname), 'api_url_invalid')
  const target = url.toString().replace(/\/$/, '')
  const stateFile = path.resolve(options.stateFile), resourcesRoot = path.resolve(options.resourcesRoot)
  noLinks(stateFile); noLinks(resourcesRoot); noLinks(options.tokenFile)
  const inputs = [path.resolve(options.manifest), path.resolve(options.tokenFile), ...manifest.questions.flatMap((q) => [path.resolve(root, q.selfTest.codePath), ...(q.selfTest.opponent ? [path.resolve(root, q.selfTest.opponent.codePath)] : []), ...q.resources.map((r) => path.resolve(root, r.sourcePath))])]
  requireThat(!inputs.some((input) => input.toLowerCase() === stateFile.toLowerCase()), 'state_must_not_overwrite_input')
  requireThat(!resourcesRoot.startsWith(root + path.sep) && resourcesRoot !== root, 'resources_root_must_be_separate_from_inputs')
  requireThat(fs.statSync(options.tokenFile).size <= 16384, 'token_file_too_large')
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim()
  requireThat(token.length >= 16 && !/\s/.test(token), 'token_file_invalid')
  const pollMs = options.pollMs ?? 2000, concurrency = options.concurrency ?? 2
  requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4 && Number.isFinite(pollMs) && pollMs >= 0 && pollMs <= 30000, 'execution_limits_invalid')
  const log = options.log || ((event) => console.log(JSON.stringify(event)))
  const state: ImportState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { schemaVersion: 1, packId: manifest.packId, target, manifestDigest, bindingsDigest: sha256(canonical(bindings)), resourcesRootDigest: sha256(resourcesRoot), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), packages: {}, questions: {}, poolDigests: {} }
  requireThat(state.schemaVersion === 1 && state.packId === manifest.packId && state.target === target && state.manifestDigest === manifestDigest && state.bindingsDigest === sha256(canonical(bindings)) && state.resourcesRootDigest === sha256(resourcesRoot), 'state_frozen_inputs_changed')
  requireThat(Object.keys(state.questions).every((id) => COURSE_PACK_IDS.includes(id)), 'state_question_scope_invalid')
  // verify is GET-only and does not create or modify even the local state/lock/resources.
  const writable = stage !== 'verify'
  let lock: number | undefined
  if (writable) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    try { lock = fs.openSync(stateFile + '.lock', 'wx', 0o600) } catch { throw new ImportError('import_state_locked') }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  }
  function save() {
    if (!writable) return
    state.updatedAt = new Date().toISOString()
    noLinks(stateFile)
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, stateFile)
  }
  let httpRequests = 0
  async function request(route: string, method = 'GET', data?: any, missing = false): Promise<any> {
    requireThat(!route.includes('..') && route.startsWith('/') && !route.startsWith('//'), 'internal_route_invalid')
    requireThat(writable || method === 'GET', 'verify_write_forbidden')
    const multipart = data instanceof FormData
    let response: Response
    try {
      httpRequests++
      response = await fetch(target + route, { method, redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${token}`, ...(data !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : multipart ? data : JSON.stringify(data) })
    } catch { throw new ImportError('http_outcome_unknown') }
    if (missing && response.status === 404) return null
    let result: any
    try { result = await response.json() } catch { throw new ImportError('http_response_invalid') }
    requireThat(response.ok && result.code === 0, `http_${response.status}_operation_failed`)
    return result.data
  }
  const qroute = (id: string) => `/admin/questions/${encodeURIComponent(id)}`
  const markerFor = (id: string) => ({ coursePackImport: { packId: manifest.packId, manifestDigest, marker: state.questions[id].marker } })
  function body(q: CoursePackQuestion, status: 'draft' | 'published', installed = false) {
    const pkg = installed ? state.packages[q.packageKey] : undefined
    return { id: q.id, title: q.title, moduleCode: q.moduleCode, number: q.number, difficulty: q.difficulty, category: q.category, scenarioId: q.scenarioId || null, role: q.role || null, content: q.content, answerTemplate: q.answerTemplate, type: 'code', status, testConfig: markerFor(q.id), definition: boundDefinition(q, pkg?.id, status === 'published' ? pkg?.digest : undefined) }
  }
  function matches(actual: any, expected: any) {
    if (!object(actual)) return false
    return Object.entries(expected).every(([key, value]) => {
      let received = actual[key]
      if (key === 'testConfig' && typeof received === 'string') { try { received = JSON.parse(received) } catch { return false } }
      return canonical(received) === canonical(value)
    })
  }
  function assertOwned(q: CoursePackQuestion, current: any) {
    requireThat(state.questions[q.id] && current, 'owned_question_missing')
    requireThat(matches(current, body(q, 'draft')) || (state.packages[q.packageKey] && (matches(current, body(q, 'draft', true)) || matches(current, body(q, 'published', true)))), 'existing_question_not_owned_or_changed')
  }
  async function ensurePools() {
    const definitions = rows.map((q) => boundDefinition(q))
    const needed = [...new Set(definitions.flatMap((d) => [...(d.llm.enabled ? [d.llm.poolId!] : []), ...(d.teacherApi.enabled ? [d.teacherApi.poolId!] : [])]))]
    const result: Record<string, PoolBinding> = {}
    if (!needed.length) return result
    const pools = await request('/admin/api-pool')
    requireThat(Array.isArray(pools), 'pool_list_invalid')
    for (const id of needed) {
      const p = pools.find((candidate: any) => candidate.id === id)
      requireThat(p?.enabled && Number.isSafeInteger(p.revision), 'required_pool_unavailable')
      const binding = { poolId: p.id, revision: p.revision, name: p.name, kind: p.kind, model: p.model, modelVersion: p.modelVersion, baseUrl: p.baseUrl, credentialEnv: p.credentialEnv, parameters: p.parameters }
      const fingerprint = sha256(canonical(binding))
      requireThat(!state.poolDigests[id] || state.poolDigests[id] === fingerprint, 'frozen_pool_changed')
      if (writable) state.poolDigests[id] = fingerprint
      result[id] = binding
    }
    for (const d of definitions) {
      requireThat(!d.llm.enabled || result[d.llm.poolId!]?.kind === 'llm', 'llm_pool_kind_mismatch')
      requireThat(!d.teacherApi.enabled || result[d.teacherApi.poolId!]?.kind === 'teacher', 'teacher_pool_kind_mismatch')
    }
    return result
  }
  function inspectResources(q: CoursePackQuestion, write: boolean, required = false) {
    const directory = path.join(resourcesRoot, q.id)
    noLinks(directory)
    if (fs.existsSync(directory)) {
      requireThat(fs.statSync(directory).isDirectory(), 'resource_question_directory_invalid')
      const allowed = new Set(q.resources.map((r) => r.filename))
      requireThat(fs.readdirSync(directory).every((name) => allowed.has(name)), 'resource_directory_contains_unlisted_files')
    }
    for (const resource of q.resources) {
      const destination = path.join(directory, resource.filename)
      noLinks(destination)
      if (fs.existsSync(destination)) {
        requireThat(fs.statSync(destination).isFile() && sha256(fs.readFileSync(destination)) === resource.sha256, 'existing_resource_digest_conflict')
      } else if (write) {
        fs.mkdirSync(directory, { recursive: true })
        const bytes = inputFile(root, resource.sourcePath, resource.sha256)
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 })
      } else requireThat(!required && stage !== 'verify' && stage !== 'publish', 'published_resource_missing')
    }
  }
  try {
    requireThat((await request('/auth/me'))?.user?.role === 'admin', 'administrator_required')
    const pools = await ensurePools()
    // Complete ownership/conflict inspection for the entire selected set before any mutation.
    for (const q of rows) {
      const current = await request(qroute(q.id), 'GET', undefined, true)
      if (current) assertOwned(q, current)
      else requireThat((stage === 'prepare' || stage === 'all') && !state.questions[q.id]?.created, 'question_missing_or_stage_not_prepared')
      inspectResources(q, false)
      if (!state.questions[q.id]) requireThat(!fs.existsSync(path.join(resourcesRoot, q.id)), 'unowned_resource_directory_exists')
    }
    if (stage === 'prepare' || stage === 'all') {
      for (const q of rows) {
        if (!state.questions[q.id]) state.questions[q.id] = { marker: crypto.randomUUID(), tests: {} }
      }
      save()
      for (const q of rows) {
        let current = await request(qroute(q.id), 'GET', undefined, true)
        if (!current) current = await request('/admin/questions', 'POST', body(q, 'draft'))
        assertOwned(q, current)
        state.questions[q.id].created = true; save()
      }
      const installedPackages = await request('/admin/evaluation-packages')
      requireThat(Array.isArray(installedPackages), 'package_list_invalid')
      for (const key of new Set(rows.map((q) => q.packageKey))) {
        const item = manifest.packages.find((p) => p.key === key)!
        const directory = packageFiles(root, item), zip = new AdmZip()
        for (const file of [...item.files].sort((a, b) => a.path.localeCompare(b.path))) zip.addFile(file.path, inputFile(directory, file.path, file.sha256, ARCHIVE_LIMITS.fileBytes))
        const bytes = zip.toBuffer()
        let decoded: Map<string, Buffer>
        try { decoded = decodeEvaluationArchive(bytes) } catch { throw new ImportError('package_archive_invalid') }
        const expectedDigest = sha256(JSON.stringify(Object.fromEntries([...decoded].map(([name, data]) => [name, sha256(data)]))))
        let descriptor = state.packages[key] || installedPackages.find((p: any) => p.digest === expectedDigest)
        if (!descriptor) {
          const form = new FormData()
          form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'course-pack-v3.zip')
          descriptor = await request('/admin/evaluation-packages', 'POST', form)
          installedPackages.push(descriptor)
        }
        requireThat(typeof descriptor.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(descriptor.id) && descriptor.digest === expectedDigest, 'package_digest_mismatch')
        const verified = await request(`/admin/evaluation-packages/${descriptor.id}/validate`, 'POST')
        requireThat(verified.id === descriptor.id && verified.digest === expectedDigest && verified.valid === true, 'installed_package_invalid')
        state.packages[key] = { id: descriptor.id, digest: descriptor.digest }; save()
      }
      for (const q of rows) {
        const current = await request(qroute(q.id))
        assertOwned(q, current)
        if (current.status !== 'published' && !matches(current, body(q, 'draft', true))) {
          const updated = await request(qroute(q.id), 'PUT', body(q, 'draft', true))
          requireThat(matches(updated, body(q, 'draft', true)), 'prepared_question_mismatch')
        }
        inspectResources(q, true)
        state.questions[q.id].prepared = true; save(); log({ questionId: q.id, stage: 'prepared' })
      }
    }
    const phases = (q: CoursePackQuestion): Phase[] => q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']
    function identity(q: CoursePackQuestion, phase: Phase) {
      const pkg = state.packages[q.packageKey]
      requireThat(pkg && state.questions[q.id]?.prepared, 'question_not_prepared')
      const definition = boundDefinition(q, pkg.id)
      const configurationKey = selfTestConfigurationKey(definition, q.role || null, q.category, definition.llm.enabled ? pools[definition.llm.poolId!] : undefined)
      const materialDigest = sha256(canonical({ reference: q.selfTest.codeSha256, weight: q.selfTest.weightFixture || null, opponent: phase === 'opponent' ? q.selfTest.opponent : null, packageDigest: pkg.digest }))
      return { pkg, definition, configurationKey, materialDigest }
    }
    async function inspectTest(q: CoursePackQuestion, phase: Phase, poll: boolean) {
      const expected = identity(q, phase), proof = state.questions[q.id].tests[phase]
      requireThat(proof?.id && proof.configurationKey === expected.configurationKey && proof.materialDigest === expected.materialDigest, 'self_test_evidence_missing_or_changed')
      const deadline = Date.now() + expected.definition.evaluation.timeoutMs + 180000
      while (true) {
        const actual = await request(`/admin/evaluation-packages/${expected.pkg.id}/self-tests/${proof.id}`)
        requireThat(actual.id === proof.id && actual.packageId === expected.pkg.id && actual.packageDigest === expected.pkg.digest && actual.configurationKey === expected.configurationKey && actual.phase === phase, 'self_test_identity_mismatch')
        if (actual.status === 'completed') {
          const r = actual.result
          requireThat(r?.status === 'completed' && r.cleanupStatus === 'cleaned', 'self_test_failed_or_not_cleaned')
          const value = phase === 'basic' ? r.score : r.metrics?.[phase === 'baseline' ? expected.definition.evaluation.baselineMetric : expected.definition.evaluation.successMetric]
          requireThat(typeof value === 'number' && Number.isFinite(value), 'self_test_metric_invalid')
          if (phase === 'basic') requireThat(value >= (q.selfTest.minimumScore ?? 0) && value <= expected.definition.evaluation.maxScore, 'basic_self_test_score_out_of_range')
          if (phase === 'baseline') requireThat(value >= expected.definition.evaluation.baselineThreshold, 'baseline_self_test_below_threshold')
          // A valid opponent loss is acceptable; it is never relabelled a win to pass publication.
          if (writable) proof.result = { status: 'completed', cleanupStatus: 'cleaned', ...(phase === 'basic' ? { score: value } : { metric: value }) }
          save(); return
        }
        requireThat(poll && ['queued', 'running'].includes(actual.status) && Date.now() < deadline, 'self_test_not_completed')
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    }
    if (stage === 'self-test' || stage === 'all') {
      let cursor = 0
      const failures: string[] = []
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
        while (cursor < rows.length) {
          const q = rows[cursor++]
          try {
            assertOwned(q, await request(qroute(q.id)))
            for (const phase of phases(q)) {
              const expected = identity(q, phase), tests = state.questions[q.id].tests
              let proof = tests[phase]
              requireThat(!proof || (proof.configurationKey === expected.configurationKey && proof.materialDigest === expected.materialDigest), 'self_test_inputs_changed')
              const recovery = options.recoverSelfTests?.[q.id]?.[phase]
              if (recovery) {
                requireThat(proof?.intent && !proof.id && /^[A-Za-z0-9_-]{1,80}$/.test(recovery), 'self_test_recovery_not_applicable')
                proof.id = recovery; save()
              }
              if (proof?.id && options.retryFailed) {
                const old = await request(`/admin/evaluation-packages/${expected.pkg.id}/self-tests/${proof.id}`)
                requireThat(old.id === proof.id && old.packageId === expected.pkg.id && old.packageDigest === expected.pkg.digest && old.configurationKey === expected.configurationKey && old.phase === phase, 'retry_test_identity_mismatch')
                if (old.status === 'completed' && old.result?.status !== 'completed' && old.result?.cleanupStatus === 'cleaned') {
                  tests[phase] = proof = { configurationKey: expected.configurationKey, materialDigest: expected.materialDigest, failed: [...(proof.failed || []), proof.id] }
                  save()
                }
              }
              if (!proof?.id) {
                requireThat(!proof?.intent, 'self_test_post_outcome_unknown_requires_reconciliation')
                tests[phase] = proof = { ...proof, configurationKey: expected.configurationKey, materialDigest: expected.materialDigest, intent: true }
                save()
                const created = await request(`/admin/evaluation-packages/${expected.pkg.id}/self-tests`, 'POST', { code: readCode(root, q.selfTest), ...(q.selfTest.weightFixture ? { weightFixture: q.selfTest.weightFixture } : {}), definition: expected.definition, category: q.category, role: q.role || null, phase, ...(phase === 'opponent' ? { opponent: { code: readCode(root, q.selfTest.opponent!), ...(q.selfTest.opponent!.weightFixture ? { weightFixture: q.selfTest.opponent!.weightFixture } : {}) } } : {}) })
                requireThat(typeof created.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(created.id), 'created_self_test_id_invalid')
                proof.id = created.id; save()
              }
              await inspectTest(q, phase, true)
              log({ questionId: q.id, stage: 'self-test-completed', phase })
            }
          } catch (error) {
            const reason = error instanceof ImportError ? error.reason : 'self_test_operation_failed'
            failures.push(q.id); log({ questionId: q.id, stage: 'self-test-failed', reason })
          }
        }
      }))
      requireThat(!failures.length, 'selected_self_tests_failed')
    }
    if (stage === 'publish' || stage === 'verify' || stage === 'all') {
      // Re-read every proof and resource before publishing the first selected question.
      for (const q of rows) {
        assertOwned(q, await request(qroute(q.id)))
        inspectResources(q, false, true)
        for (const phase of phases(q)) await inspectTest(q, phase, false)
      }
      for (const q of rows) {
        let current = await request(qroute(q.id))
        assertOwned(q, current)
        if (current.status !== 'published') {
          requireThat(writable, 'question_not_published')
          current = await request(qroute(q.id), 'PUT', body(q, 'published', true))
        }
        requireThat(matches(current, body(q, 'published', true)) && Number.isInteger(current.revision), 'published_question_mismatch')
        if (writable) { state.questions[q.id].published = { revision: current.revision, updatedAt: current.updatedAt }; save() }
        const visible = await request(`/questions/${encodeURIComponent(q.id)}`)
        requireThat(visible.id === q.id && visible.status === 'published' && visible.revision === current.revision && visible.content === q.content && visible.answerTemplate === q.answerTemplate && visible.category === q.category && visible.role === (q.role || null), 'public_question_mismatch')
        const listed = await request(`/questions/${encodeURIComponent(q.id)}/resources`)
        requireThat(Array.isArray(listed) && canonical(listed.map((r: any) => r.filename).sort()) === canonical(q.resources.map((r) => r.filename).sort()), 'public_resource_list_mismatch')
        for (const resource of q.resources) {
          let response: Response
          try { httpRequests++; response = await fetch(`${target}/questions/${encodeURIComponent(q.id)}/resources/${encodeURIComponent(resource.filename)}`, { redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${token}` } }) } catch { throw new ImportError('resource_download_failed') }
          requireThat(response.ok && sha256(Buffer.from(await response.arrayBuffer())) === resource.sha256, 'public_resource_digest_mismatch')
        }
        log({ questionId: q.id, stage: 'verified', revision: current.revision })
      }
    }
    return { ...plan, status: 'completed', httpRequests, prepared: rows.filter((q) => state.questions[q.id]?.prepared).length, published: rows.filter((q) => state.questions[q.id]?.published).length, selfTests: rows.reduce((n, q) => n + Object.values(state.questions[q.id]?.tests || {}).filter((t) => t.result?.status === 'completed').length, 0) }
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(stateFile + '.lock') }
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { manifest: { type: 'string' }, api: { type: 'string' }, 'token-file': { type: 'string' }, state: { type: 'string' }, 'resources-root': { type: 'string' }, stage: { type: 'string', default: 'prepare' }, 'dry-run': { type: 'boolean', default: false }, only: { type: 'string' }, 'pool-bindings': { type: 'string' }, 'recover-self-tests': { type: 'string' }, 'retry-failed': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '2' } } })
  requireThat(values.manifest, 'manifest_option_required')
  const read = (filename?: string) => filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : undefined
  const report = await importCoursePack({ manifest: values.manifest, api: values.api, tokenFile: values['token-file'], stateFile: values.state, resourcesRoot: values['resources-root'], stage: values.stage as Stage, dryRun: values['dry-run'], only: values.only?.split(','), poolBindings: read(values['pool-bindings']), recoverSelfTests: read(values['recover-self-tests']), retryFailed: values['retry-failed'], concurrency: Number(values.concurrency) })
  console.log(JSON.stringify(report)); return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: 'failed', reason: error instanceof ImportError ? error.reason : 'import_setup_failed' })); process.exitCode = 1 })
}
