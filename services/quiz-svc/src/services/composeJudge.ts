import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { compatibleWorkerBootstrap } from './workerBootstrapCompatibility.js'
import { evaluationModelCallLimit, isOriginalD02Evaluation, ORIGINAL_D02_TIMEOUT_MS } from '../lib/modelCallBudget.js'
import { SUBMISSION_PREFLIGHT_SOURCE, decodePreflight } from './submissionPreflight.js'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PLATFORM_STUDENT_CLIENT_SOURCE as STUDENT_CLIENT,
  PLATFORM_STUDENT_WORKER_SOURCE as STUDENT_WORKER,
} from './studentRpc.js'
import {
  EVALUATION_PACKAGE_ROOT,
  assertWithin,
  safeRelativeName,
  snapshotEvaluationPackage,
  validateManifest,
  type EvaluationManifest,
  type EvaluationPhase,
} from '../lib/evaluationPackage.js'

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RESULT_MARKER = 'PLATFORM_EVALUATION_RESULT:'
export interface ComposeEvaluationInput {
  submissionId: string
  attemptId: string
  questionVersion: number
  evaluationVersion: string
  packageId: string
  code: string
  answerTemplate?: string | null
  filePath: string | null
  phase: EvaluationPhase
  role?: 'attack' | 'defense'
  parameters?: Record<string, unknown>
  baseline?: { code?: string; fixture?: string; weightFixture?: string; filePath?: string | null }
  opponent?: { submissionId: string; code: string; filePath: string | null }
  /** Broker-issued, attempt-scoped credentials; never a student-selected endpoint. Only the trusted relay sees this token. */
  modelGateway?: { url: string; token: string }
  timeoutMs?: number
}
export interface ComposeEvaluationResult {
  status: 'completed' | 'student_error' | 'timeout' | 'system_error'
  score?: number
  maxScore?: number
  metrics?: Record<string, number>
  success?: boolean
  publicMessage?: string
  cleanupStatus: 'cleaned' | 'cleanup_failed' | 'not_started'
}
export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}
export interface CommandOptions {
  cwd: string
  timeoutMs: number
  maxBufferBytes: number
  env: NodeJS.ProcessEnv
}
export type CommandExecutor = (
  binary: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>
class EvaluationDeadlineError extends Error {}
class SubmissionPreflightError extends Error {}

const CONTAINER_ADDRESS_FORMAT =
  '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"networks":{{json .NetworkSettings.Networks}}}'
const NETWORK_ADDRESS_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"internal":{{json .Internal}},"project":{{json (index .Labels "com.docker.compose.project")}},"network":{{json (index .Labels "com.docker.compose.network")}},"containers":{{json .Containers}}}'

/** Resolve only Docker-owned, healthy services on this attempt's exact internal lane; never use DNS or a student URL. */
async function discoverServiceAddress(
  command: (args: string[]) => Promise<CommandResult>,
  composeArgs: string[],
  project: string,
  service: 'student' | 'opponent' | 'gateway',
): Promise<string> {
  const found = await command([...composeArgs, 'ps', '--quiet', service])
  if (found.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(found.stdout.trim()))
    throw new Error('评测服务容器标识无效')
  const id = found.stdout.trim()
  const inspected = await command([
    'inspect',
    '--type',
    'container',
    '--format',
    CONTAINER_ADDRESS_FORMAT,
    id,
  ])
  if (inspected.exitCode !== 0) throw new Error('无法检查评测服务')
  const container: unknown = JSON.parse(inspected.stdout)
  if (
    !isObject(container) ||
    container.id !== id ||
    container.project !== project ||
    container.service !== service ||
    container.running !== true ||
    container.health !== 'healthy' ||
    !isObject(container.networks)
  )
    throw new Error('评测服务归属或健康状态不匹配')
  const lane = service === 'gateway' ? 'job-internal' : `${service}-lane`
  const networkName = `${project}_${lane}`
  const containerNetworks = container.networks
  const expectedNetworks = service === 'gateway' ? [networkName, `${project}_gateway-egress`] : [networkName]
  if (
    Object.keys(containerNetworks).length !== expectedNetworks.length ||
    expectedNetworks.some((name) => !Object.hasOwn(containerNetworks, name))
  )
    throw new Error('评测服务网络隔离配置不匹配')
  const endpoint = containerNetworks[networkName]
  if (
    !isObject(endpoint) ||
    typeof endpoint.NetworkID !== 'string' ||
    !/^[0-9a-f]{64}$/.test(endpoint.NetworkID) ||
    typeof endpoint.IPAddress !== 'string' ||
    isIP(endpoint.IPAddress) !== 4
  )
    throw new Error('评测服务网络地址无效')
  const octets = endpoint.IPAddress.split('.').map(Number)
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254))
    throw new Error('评测服务网络地址不可用')
  const networkResult = await command([
    'network',
    'inspect',
    '--format',
    NETWORK_ADDRESS_FORMAT,
    endpoint.NetworkID,
  ])
  if (networkResult.exitCode !== 0) throw new Error('无法检查评测内部网络')
  const network: unknown = JSON.parse(networkResult.stdout)
  if (
    !isObject(network) ||
    network.id !== endpoint.NetworkID ||
    network.name !== networkName ||
    network.internal !== true ||
    network.project !== project ||
    network.network !== lane ||
    !isObject(network.containers)
  )
    throw new Error('评测内部网络归属不匹配')
  const member = network.containers[id]
  if (
    !isObject(member) ||
    typeof member.IPv4Address !== 'string' ||
    member.IPv4Address.split('/')[0] !== endpoint.IPAddress ||
    !/^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(member.IPv4Address)
  )
    throw new Error('评测服务不属于指定内部网络')
  return endpoint.IPAddress
}
export interface ComposeJudgeOptions {
  executor?: CommandExecutor
  packageRoot?: string
  workspaceRoot?: string
  /** Path of the same workspace mount as seen by the Docker daemon, when this service itself is containerized. */
  hostWorkspaceRoot?: string
  materialRoots?: string[]
  dockerBinary?: string
}
export const defaultCommandExecutor: CommandExecutor = (binary, args, options) =>
  new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        env: options.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const e = error as (Error & { code?: string | number; killed?: boolean }) | null
        resolve({
          exitCode: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: !!e?.killed && e?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        })
      },
    )
  })
function dockerEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    if (process.env[key] !== undefined) result[key] = process.env[key]
  result.COMPOSE_ANSI = 'never'
  return result
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function validateParameters(parameters: unknown): Record<string, unknown> {
  const result = parameters ?? {}
  if (!isObject(result)) throw new Error('parameters必须为对象')
  function visit(value: unknown, depth: number): void {
    if (depth > 8) throw new Error('parameters嵌套过深')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('parameters包含非有限数值')
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return
    if (Array.isArray(value)) {
      if (value.length > 1000) throw new Error('parameters数组过长')
      for (const v of value) visit(v, depth + 1)
      return
    }
    if (!isObject(value) || Object.keys(value).length > 200) throw new Error('parameters必须为JSON数据')
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('parameters包含保留字段')
      visit(v, depth + 1)
    }
  }
  visit(result, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error('parameters大小超限')
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>
}
function validateInput(input: ComposeEvaluationInput): void {
  for (const value of [input.submissionId, input.attemptId, input.evaluationVersion])
    if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f]/.test(value))
      throw new Error('评测绑定标识无效')
  if (!Number.isSafeInteger(input.questionVersion) || input.questionVersion < 1)
    throw new Error('题目版本无效')
  if (!['basic', 'baseline', 'opponent'].includes(input.phase)) throw new Error('评测阶段无效')
  if (input.role !== undefined && !['attack', 'defense'].includes(input.role)) throw new Error('角色无效')
  if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('代码不能为空')
  if (
    input.phase === 'opponent' &&
    (!input.opponent || typeof input.opponent.submissionId !== 'string' || !input.opponent.submissionId)
  )
    throw new Error('缺少不可变对手材料')
  if (input.modelGateway) {
    const u = new URL(input.modelGateway.url)
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !input.modelGateway.token
    )
      throw new Error('模型网关配置无效')
  }
  validateParameters(input.parameters)
}
function digestFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function readonlyFile(file: string, data: string): void {
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o444 })
}
function copyWeights(
  source: string | null | undefined,
  destination: string,
  manifest: EvaluationManifest,
  roots: string[],
  required: boolean,
): string | null {
  if (!source) {
    if (required) throw new Error('缺少必需参数文件')
    return null
  }
  const absolute = fs.realpathSync(source)
  if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(absolute).isFile())
    throw new Error('参数文件必须为普通文件')
  if (
    !roots.some((root) => {
      try {
        assertWithin(fs.realpathSync(root), absolute)
        return true
      } catch {
        return false
      }
    })
  )
    throw new Error('参数文件不在材料目录中')
  if (fs.statSync(absolute).size > manifest.materials.maxWeightBytes) throw new Error('参数文件大小超限')
  fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, 0o444)
  return digestFile(destination)
}
const PLATFORM_ENTRY = String.raw`import contextlib, json, pathlib, runpy, sys, traceback
context = json.loads(pathlib.Path('/input/context.json').read_text())
entry = '/package/' + context['entrypoint']
sys.path.insert(0, '/package')
sys.path.insert(0, str(pathlib.Path(entry).parent))
sys.path.insert(0, '/platform')
sys.argv = [entry, '/input/context.json', '/output/result.json']
try:
    runpy.run_path(entry, run_name='__main__')
except SystemExit as error:
    if error.code not in (None, 0):
        raise
result = pathlib.Path('/output/result.json')
if not result.is_file() or result.is_symlink() or result.stat().st_size > 65536:
    raise RuntimeError('missing or oversized evaluation result')
payload = json.loads(result.read_text())
print('PLATFORM_EVALUATION_RESULT:' + json.dumps(payload, ensure_ascii=True, allow_nan=False), flush=True)
`
export const PLATFORM_STUDENT_CLIENT_SOURCE = STUDENT_CLIENT
export const PLATFORM_STUDENT_WORKER_SOURCE = STUDENT_WORKER
/** Fixed relay code contains no uploaded source. Upstream credentials are mounted only into the relay container. */
const GATEWAY_RELAY = String.raw`import http.server, json, pathlib, threading, urllib.request, urllib.error
config = json.loads(pathlib.Path('/relay/context.json').read_text())
lock = threading.Lock()
calls = 0
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        global calls
        if self.path not in ('/v1/chat/completions', '/chat/completions') or self.headers.get('Authorization') != 'Bearer ' + config['localToken']:
            self.send_error(403); return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 1048576: self.send_error(413); return
            with lock:
                if calls >= config['maxCalls']: self.send_error(429); return
                calls += 1
            body = self.rfile.read(size)
            json.loads(body)
            request = urllib.request.Request(config['url'].rstrip('/') + '/chat/completions', data=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token']}, method='POST')
            try:
                # Allow the bounded 300s pool request to return its classified
                # outcome. The runner's overall attempt deadline still applies.
                with urllib.request.urlopen(request, timeout=315) as response:
                    data = response.read(8388609)
                    if len(data) > 8388608: self.send_error(502); return
                    self.send_response(response.status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            except urllib.error.HTTPError as error:
                self.send_error(error.code if 400 <= error.code <= 599 else 502)
        except Exception: self.send_error(502)
http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
`
export const PLATFORM_MODEL_GATEWAY_RELAY_SOURCE = GATEWAY_RELAY
function controlledService(manifest: EvaluationManifest): Record<string, unknown> {
  return {
    image: manifest.image,
    user: '10001:10001',
    read_only: true,
    init: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: manifest.resources.pids,
    mem_limit: `${manifest.resources.memoryMb}m`,
    memswap_limit: `${manifest.resources.memoryMb}m`,
    cpus: manifest.resources.cpus,
    environment: { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    tmpfs: [
      `/tmp:rw,noexec,nosuid,nodev,size=${manifest.resources.tmpMb}m,uid=10001,gid=10001,mode=700`,
      '/output:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700',
    ],
    logging: { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '1' } },
    restart: 'no',
  }
}
export function buildControlledCompose(
  workspace: string,
  manifest: EvaluationManifest,
  gateway: boolean,
  opponent = false,
): Record<string, unknown> {
  const evaluator: Record<string, unknown> = {
    ...controlledService(manifest),
    working_dir: '/tmp',
    command: ['python', '-I', '/platform/entry.py'],
    volumes: [
      { type: 'bind', source: path.join(workspace, 'package'), target: '/package', read_only: true },
      { type: 'bind', source: path.join(workspace, 'input'), target: '/input', read_only: true },
      { type: 'bind', source: path.join(workspace, 'platform'), target: '/platform', read_only: true },
    ],
  }
  const networks: Record<string, unknown> = { 'student-lane': { internal: true } }
  const healthcheck = {
    test: [
      'CMD',
      'python',
      '-c',
      "import socket; socket.create_connection(('127.0.0.1', 9000), timeout=1).close()",
    ],
    interval: '1s',
    timeout: '2s',
    retries: 10,
    start_period: '1s',
  }
  const worker = (name: string) => ({
    ...controlledService(manifest),
    working_dir: '/materials',
    command: ['python', '-I', '/worker/server.py'],
    volumes: [
      {
        type: 'bind',
        source: path.join(workspace, name, 'materials'),
        target: '/materials',
        read_only: true,
      },
      { type: 'bind', source: path.join(workspace, name, 'runtime'), target: '/worker', read_only: true },
    ],
    networks: [`${name}-lane`],
    healthcheck,
  })
  const services: Record<string, unknown> = { evaluator, student: worker('student') }
  const depends: Record<string, unknown> = { student: { condition: 'service_healthy' } }
  const evaluatorNetworks = ['student-lane']
  if (opponent) {
    services.opponent = worker('opponent')
    networks['opponent-lane'] = { internal: true }
    depends.opponent = { condition: 'service_healthy' }
    evaluatorNetworks.push('opponent-lane')
  }
  evaluator.networks = evaluatorNetworks
  evaluator.depends_on = depends
  if (!gateway) return { services, networks }
  networks['job-internal'] = { internal: true }
  networks['gateway-egress'] = { driver: 'bridge' }
  evaluatorNetworks.push('job-internal')
  depends.gateway = { condition: 'service_healthy' }
  const relayManifest = validateManifest({
    ...manifest,
    image: process.env.EVALUATION_RELAY_IMAGE || 'python:3.12-slim',
    resources: { ...manifest.resources, cpus: 0.25, memoryMb: 128, pids: 32 },
  })
  const gatewayService = {
    ...controlledService(relayManifest),
    working_dir: '/tmp',
    command: ['python', '-I', '/relay/relay.py'],
    volumes: [{ type: 'bind', source: path.join(workspace, 'relay'), target: '/relay', read_only: true }],
    networks: ['job-internal', 'gateway-egress'],
    extra_hosts: ['host.docker.internal:host-gateway'],
    healthcheck: {
      test: [
        'CMD',
        'python',
        '-c',
        "import socket; socket.create_connection(('127.0.0.1', 8080), timeout=1).close()",
      ],
      interval: '1s',
      timeout: '2s',
      retries: 10,
      start_period: '1s',
    },
  }
  services.gateway = gatewayService
  return { services, networks }
}
interface CleanupJournal {
  project: string
  workspace: string
  compose: Record<string, unknown>
  createdAt: string
  expiresAt: number
  state: 'running' | 'cleanup_failed'
}
export async function recoverPendingComposeCleanups(
  options: ComposeJudgeOptions = {},
): Promise<{ recovered: number; pending: number }> {
  const root = path.resolve(
    options.workspaceRoot ??
      process.env.EVALUATION_WORKSPACE_ROOT ??
      path.join(os.tmpdir(), 'platform-evaluations'),
  )
  const directory = path.join(root, '_cleanup')
  if (!fs.existsSync(directory)) return { recovered: 0, pending: 0 }
  let recovered = 0,
    pending = 0
  for (const name of fs.readdirSync(directory)) {
    if (!/^eval-[0-9a-f]{32}\.json$/.test(name)) continue
    const file = path.join(directory, name)
    const composeFile = path.join(directory, name.replace(/\.json$/, '.compose.json'))
    const lockFile = `${file}.lock`
    let ownsLock = false
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('invalid journal')
      const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as CleanupJournal
      if (`${journal.project}.json` !== name || !/^eval-[0-9a-f]{32}$/.test(journal.project))
        throw new Error('invalid project')
      if (!Number.isFinite(journal.expiresAt) || !['running', 'cleanup_failed'].includes(journal.state))
        throw new Error('invalid recovery lease')
      if (journal.state === 'running' && journal.expiresAt > Date.now()) continue
      // Cross-process recovery claim; stale claims expire after a bound longer than one Docker down.
      try {
        const descriptor = fs.openSync(lockFile, 'wx', 0o600)
        fs.closeSync(descriptor)
        ownsLock = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (fs.statSync(lockFile).mtimeMs + 60000 < Date.now()) {
          fs.rmSync(lockFile, { force: true })
          continue
        }
        continue
      }
      assertWithin(root, journal.workspace)
      if (!/^attempt-[A-Za-z0-9]+$/.test(path.basename(journal.workspace)))
        throw new Error('invalid workspace')
      fs.writeFileSync(composeFile, JSON.stringify(journal.compose), { mode: 0o600 })
      const down = await (options.executor ?? defaultCommandExecutor)(
        options.dockerBinary ?? process.env.EVALUATION_DOCKER_BIN ?? 'docker',
        [
          'compose',
          '--project-name',
          journal.project,
          '--file',
          composeFile,
          'down',
          '--volumes',
          '--remove-orphans',
          '--timeout',
          '5',
        ],
        { cwd: directory, timeoutMs: 20000, maxBufferBytes: 256 * 1024, env: dockerEnv() },
      )
      if (down.exitCode !== 0) throw new Error('cleanup pending')
      // Only the journal's verified per-attempt directory can be removed. Never prune the daemon globally.
      fs.rmSync(journal.workspace, { recursive: true, force: true })
      fs.rmSync(file, { force: true })
      recovered += 1
    } catch {
      pending += 1
    } finally {
      if (ownsLock) {
        try {
          fs.rmSync(composeFile, { force: true })
          fs.rmSync(lockFile, { force: true })
        } catch {
          /* stale claim can be retried */
        }
      }
    }
  }
  return { recovered, pending }
}
function publicMessage(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== 'string') return undefined
  let result = value.slice(0, 500).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]')
  return result
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(?:[A-Za-z]:\\|\/(?:app|input|package|relay|tmp)\/)[^\s]+/g, '[internal path]')
}
export function validateEvaluationResult(
  raw: unknown,
  input: ComposeEvaluationInput,
  secrets: string[] = [],
): Omit<ComposeEvaluationResult, 'cleanupStatus'> {
  if (!isObject(raw)) throw new Error('评测结果必须为对象')
  const allowed = [
    'submissionId',
    'attemptId',
    'questionVersion',
    'evaluationVersion',
    'phase',
    'opponentSubmissionId',
    'status',
    'score',
    'maxScore',
    'metrics',
    'success',
    'publicMessage',
  ]
  if (Object.keys(raw).some((k) => !allowed.includes(k))) throw new Error('评测结果包含未定义字段')
  for (const key of ['submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase'] as const)
    if (raw[key] !== input[key]) throw new Error('评测结果绑定不匹配')
  if (input.phase === 'opponent' && raw.opponentSubmissionId !== input.opponent?.submissionId)
    throw new Error('对手结果绑定不匹配')
  if (!['completed', 'student_error', 'timeout', 'system_error'].includes(String(raw.status)))
    throw new Error('结果状态无效')
  const result: Omit<ComposeEvaluationResult, 'cleanupStatus'> = {
    status: raw.status as ComposeEvaluationResult['status'],
    publicMessage: publicMessage(raw.publicMessage, secrets),
  }
  if (raw.status !== 'completed') {
    if (raw.score !== undefined || raw.maxScore !== undefined || raw.success !== undefined)
      throw new Error('异常结果不得携带成绩')
    return result
  }
  if (raw.metrics !== undefined) {
    if (!isObject(raw.metrics) || Object.keys(raw.metrics).length > 100) throw new Error('指标格式无效')
    for (const [key, v] of Object.entries(raw.metrics))
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || typeof v !== 'number' || !Number.isFinite(v))
        throw new Error('指标必须为有限数值')
    result.metrics = raw.metrics as Record<string, number>
  }
  if (input.phase === 'basic') {
    if (
      typeof raw.score !== 'number' ||
      typeof raw.maxScore !== 'number' ||
      !Number.isFinite(raw.score) ||
      !Number.isFinite(raw.maxScore) ||
      raw.maxScore <= 0 ||
      raw.maxScore > 1000000 ||
      raw.score < 0 ||
      raw.score > raw.maxScore
    )
      throw new Error('成绩超出允许范围')
    result.score = raw.score
    result.maxScore = raw.maxScore
  } else if (input.phase === 'baseline') {
    const metric =
      typeof input.parameters?.baselineMetric === 'string'
        ? input.parameters.baselineMetric
        : 'qualificationMetric'
    if (!result.metrics || result.metrics[metric] === undefined)
      throw new Error('基线阶段必须返回题目声明的资格指标')
  } else {
    if (typeof raw.success !== 'boolean') throw new Error('对抗阶段必须返回布尔成功结果')
    const metric =
      typeof input.parameters?.successMetric === 'string' ? input.parameters.successMetric : 'successMetric'
    if (!result.metrics || result.metrics[metric] === undefined)
      throw new Error('对抗阶段必须返回题目声明的成功指标')
    result.success = raw.success
  }
  if (input.phase !== 'basic' && (raw.score !== undefined || raw.maxScore !== undefined))
    throw new Error('攻防阶段由平台汇总成绩')
  return result
}
/** Always creates a fresh project and fresh immutable materials. No uploaded Compose command is executed. */
export async function runComposeEvaluation(
  input: ComposeEvaluationInput,
  options: ComposeJudgeOptions = {},
): Promise<ComposeEvaluationResult> {
  const executor = options.executor ?? defaultCommandExecutor
  const packageRoot = options.packageRoot ?? EVALUATION_PACKAGE_ROOT
  const workspaceRoot = path.resolve(
    options.workspaceRoot ??
      process.env.EVALUATION_WORKSPACE_ROOT ??
      path.join(os.tmpdir(), 'platform-evaluations'),
  )
  const binary = options.dockerBinary ?? process.env.EVALUATION_DOCKER_BIN ?? 'docker'
  let workspace: string | undefined
  let composePath: string | undefined
  let journalPath: string | undefined
  const project = `eval-${crypto.randomUUID().replace(/-/g, '')}`
  let result: ComposeEvaluationResult = {
    status: 'system_error',
    publicMessage: '评测环境准备失败',
    cleanupStatus: 'not_started',
  }
  const secrets = [input.modelGateway?.token ?? '']
  try {
    validateInput(input)
    fs.mkdirSync(workspaceRoot, { recursive: true })
    workspace = fs.mkdtempSync(path.join(workspaceRoot, 'attempt-'))
    assertWithin(workspaceRoot, workspace)
    const descriptor = await snapshotEvaluationPackage(
      input.packageId,
      path.join(workspace, 'package'),
      packageRoot,
    )
    const manifest = descriptor.manifest
    const timeoutMs = Math.min(
      input.timeoutMs ?? manifest.resources.timeoutMs,
      manifest.resources.timeoutMs,
      input.role === 'defense' && isOriginalD02Evaluation(input.parameters) ? ORIGINAL_D02_TIMEOUT_MS : 3600000,
    )
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error('评测超时配置无效')
    if (!manifest.phases.includes(input.phase)) throw new Error('环境包不支持该评测阶段')
    if (input.modelGateway && manifest.network !== 'gateway') throw new Error('环境包未允许模型网关')
    if (manifest.network === 'gateway' && !input.modelGateway) throw new Error('题目缺少固定模型网关')
    if (Buffer.byteLength(input.code) > manifest.materials.maxCodeBytes) throw new Error('代码大小超限')
    const materialRoots = options.materialRoots ?? [
      path.join(SERVICE_ROOT, 'uploads'),
      path.join(SERVICE_ROOT, 'match-uploads'),
    ]
    const inputDirectory = path.join(workspace, 'input')
    fs.mkdirSync(inputDirectory)
    function prepareWorker(
      name: 'student' | 'opponent',
      code: string,
      filePath: string | null,
      required: boolean,
    ): Record<string, unknown> {
      const materialDirectory = path.join(workspace!, name, 'materials'),
        runtimeDirectory = path.join(workspace!, name, 'runtime')
      fs.mkdirSync(materialDirectory, { recursive: true })
      fs.mkdirSync(runtimeDirectory)
      readonlyFile(path.join(materialDirectory, 'code.py'), code)
      const weightDigest = copyWeights(
        filePath,
        path.join(materialDirectory, 'weights.bin'),
        manifest,
        materialRoots,
        required,
      )
      const token = crypto.randomBytes(32).toString('hex')
      secrets.push(token)
      // Only explicitly public helpers enter a worker; hidden tests stay in the evaluator package.
      for (const relative of manifest.worker?.files ?? []) {
        const safe = safeRelativeName(relative)
        if (!safe.startsWith('public/')) throw new Error('worker 辅助文件必须位于 public 目录')
        const source = path.resolve(workspace!, 'package', safe)
        const destination = path.resolve(runtimeDirectory, safe)
        assertWithin(path.join(workspace!, 'package'), source)
        assertWithin(runtimeDirectory, destination)
        if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink())
          throw new Error('worker 辅助文件必须为普通文件')
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        if (safe === manifest.worker?.bootstrap)
          fs.writeFileSync(destination, compatibleWorkerBootstrap(safe, fs.readFileSync(source)), { flag: 'wx' })
        else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(destination, 0o444)
      }
      const bootstrap = manifest.worker?.bootstrap
      if (bootstrap && !manifest.worker!.files.includes(bootstrap))
        throw new Error('worker bootstrap 必须列入公开文件清单')
      readonlyFile(path.join(runtimeDirectory, 'server.py'), STUDENT_WORKER)
      readonlyFile(path.join(runtimeDirectory, 'preflight.py'), SUBMISSION_PREFLIGHT_SOURCE)
      readonlyFile(path.join(runtimeDirectory, 'answer-template.py'), name === 'student' ? input.answerTemplate || '' : '')
      readonlyFile(
        path.join(runtimeDirectory, 'config.json'),
        JSON.stringify({
          token,
          ...manifest.rpc,
          timeoutSeconds: Math.max(1, timeoutMs / 1000),
          ...(bootstrap ? { bootstrap: `/worker/${bootstrap}` } : {}),
        }),
      )
      return {
        protocolVersion: 2,
        url: `http://${name}:9000`,
        token,
        ...manifest.rpc,
        timeoutSeconds: Math.max(1, timeoutMs / 1000),
        codeDigest: crypto.createHash('sha256').update(code).digest('hex'),
        weightsPath: weightDigest ? '/materials/weights.bin' : null,
        weightDigest,
      }
    }
    const student = prepareWorker('student', input.code, input.filePath, manifest.materials.requiresWeights)
    const context: Record<string, unknown> = {
      submissionId: input.submissionId,
      attemptId: input.attemptId,
      questionVersion: input.questionVersion,
      evaluationVersion: input.evaluationVersion,
      packageId: input.packageId,
      packageDigest: descriptor.digest,
      phase: input.phase,
      role: input.role ?? null,
      parameters: validateParameters(input.parameters),
      entrypoint: manifest.entrypoint,
      student,
    }
    if (input.opponent) {
      if (
        typeof input.opponent.code !== 'string' ||
        Buffer.byteLength(input.opponent.code) > manifest.materials.maxCodeBytes
      )
        throw new Error('对手代码无效或超限')
      context.opponent = {
        submissionId: input.opponent.submissionId,
        ...prepareWorker('opponent', input.opponent.code, input.opponent.filePath, false),
      }
    }
    if (input.baseline) {
      const baseline: Record<string, unknown> = {}
      fs.mkdirSync(path.join(inputDirectory, 'baseline'))
      if (input.baseline.code !== undefined) {
        if (
          typeof input.baseline.code !== 'string' ||
          Buffer.byteLength(input.baseline.code) > manifest.materials.maxCodeBytes
        )
          throw new Error('基线代码无效')
        readonlyFile(path.join(inputDirectory, 'baseline/code.py'), input.baseline.code)
        baseline.codePath = '/input/baseline/code.py'
      }
      if (input.baseline.fixture) {
        const fixture = safeRelativeName(input.baseline.fixture)
        if (!fixture.startsWith('baselines/')) throw new Error('基线fixture必须位于包内baselines目录')
        const source = path.resolve(workspace, 'package', fixture)
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('基线fixture不存在')
        baseline.fixturePath = `/package/${fixture}`
      }
      const baselineDigest = copyWeights(
        input.baseline.filePath,
        path.join(inputDirectory, 'baseline/weights.bin'),
        manifest,
        materialRoots,
        false,
      )
      baseline.weightsPath = baselineDigest ? '/input/baseline/weights.bin' : null
      if (input.baseline.weightFixture) {
        const fixture = safeRelativeName(input.baseline.weightFixture)
        if (!fixture.startsWith('baselines/') || !fs.existsSync(path.join(workspace, 'package', fixture)))
          throw new Error('基线权重fixture不存在或越界')
        baseline.weightsPath = `/package/${fixture}`
      }
      context.baseline = baseline
    }
    fs.mkdirSync(path.join(workspace, 'platform'))
    readonlyFile(path.join(workspace, 'platform/entry.py'), PLATFORM_ENTRY)
    readonlyFile(path.join(workspace, 'platform/platform_student.py'), STUDENT_CLIENT)
    if (input.modelGateway) {
      const localToken = crypto.randomBytes(32).toString('hex')
      secrets.push(localToken)
      context.modelGateway = { url: 'http://gateway:8080/v1', token: localToken }
      fs.mkdirSync(path.join(workspace, 'relay'))
      readonlyFile(path.join(workspace, 'relay/relay.py'), GATEWAY_RELAY)
      const maxCalls = evaluationModelCallLimit(input.parameters, input.role)
      readonlyFile(
        path.join(workspace, 'relay/context.json'),
        JSON.stringify({ ...input.modelGateway, localToken, maxCalls }),
      )
    }
    composePath = path.join(workspace, 'compose.json')
    const configuredHostRoot = options.hostWorkspaceRoot ?? process.env.EVALUATION_WORKSPACE_HOST_ROOT
    const hostWorkspace = configuredHostRoot
      ? path.join(configuredHostRoot, path.relative(workspaceRoot, workspace))
      : workspace
    const controlledCompose = buildControlledCompose(
      hostWorkspace,
      manifest,
      !!input.modelGateway,
      !!input.opponent,
    )
    readonlyFile(composePath, JSON.stringify(controlledCompose, null, 2))
    const journalDirectory = path.join(workspaceRoot, '_cleanup')
    fs.mkdirSync(journalDirectory, { recursive: true })
    journalPath = path.join(journalDirectory, `${project}.json`)
    const deadline = Date.now() + timeoutMs
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        project,
        workspace,
        compose: controlledCompose,
        createdAt: new Date().toISOString(),
        expiresAt: deadline + 60000,
        state: 'running',
      } satisfies CleanupJournal),
      { flag: 'wx', mode: 0o600 },
    )
    const args = ['compose', '--project-name', project, '--file', composePath]
    const commandOptions: CommandOptions = {
      cwd: workspace,
      timeoutMs,
      maxBufferBytes: 2 * 1024 * 1024,
      env: dockerEnv(),
    }
    const command = async (commandArgs: string[]): Promise<CommandResult> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new EvaluationDeadlineError('评测总时限已到')
      const response = await executor(binary, commandArgs, { ...commandOptions, timeoutMs: remaining })
      if (response.timedOut || Date.now() >= deadline) throw new EvaluationDeadlineError('评测超时')
      return response
    }
    const dependencies: ('student' | 'opponent' | 'gateway')[] = [
      'student',
      ...(input.opponent ? ['opponent' as const] : []),
      ...(input.modelGateway ? ['gateway' as const] : []),
    ]
    const ready = await command([
      ...args,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000))),
      '--no-build',
      '--pull',
      'never',
      ...dependencies,
    ])
    if (ready.exitCode !== 0) throw new Error('评测服务启动或健康检查失败')
    // Read-only AST analysis in the candidate's constrained container, before
    // student imports, weights, model calls or the trusted grader are started.
    const preflight = await command([...args, 'exec', '-T', 'student', 'python', '/worker/preflight.py',
      '/materials/code.py', '/worker/answer-template.py'])
    if (preflight.exitCode !== 0) throw new Error('submission preflight unavailable')
    const issue = decodePreflight(preflight.stdout)
    if (issue) throw new SubmissionPreflightError(issue)
    for (const service of dependencies) {
      const address = await discoverServiceAddress(command, args, project, service)
      if (service === 'gateway')
        (context.modelGateway as Record<string, unknown>).url = `http://${address}:8080/v1`
      else {
        const worker = context[service] as Record<string, unknown>
        worker.url = `http://${address}:9000`
        worker.deadline = deadline
      }
    }
    // No grader has started yet. Finalize its read-only input once all RPC endpoints are verified.
    readonlyFile(path.join(inputDirectory, 'context.json'), JSON.stringify(context))
    const start = await command([
      ...args,
      'up',
      '--abort-on-container-exit',
      '--exit-code-from',
      'evaluator',
      '--no-deps',
      '--no-build',
      '--pull',
      'never',
      'evaluator',
    ])
    if (start.exitCode !== 0)
      result = {
        status: 'system_error',
        publicMessage: '评测环境或入口运行失败，本次不计分',
        cleanupStatus: 'not_started',
      }
    else {
      const log = await command([...args, 'logs', '--no-color', '--no-log-prefix', 'evaluator'])
      const records = log.stdout.split(/\r?\n/).filter((line) => line.startsWith(RESULT_MARKER))
      if (
        log.exitCode !== 0 ||
        records.length !== 1 ||
        Buffer.byteLength(records[0]) > 65536 + RESULT_MARKER.length
      )
        throw new Error('评测结果缺失或协议无效')
      const raw: unknown = JSON.parse(records[0].slice(RESULT_MARKER.length))
      result = { ...validateEvaluationResult(raw, input, secrets), cleanupStatus: 'not_started' }
    }
  } catch (error) {
    result = {
      status: error instanceof SubmissionPreflightError ? 'student_error' : error instanceof EvaluationDeadlineError ? 'timeout' : 'system_error',
      publicMessage:
        error instanceof SubmissionPreflightError ? error.message : error instanceof EvaluationDeadlineError
          ? '评测超时，本次不计分'
          : '评测配置、材料或结果校验失败，本次不计分',
      cleanupStatus: 'not_started',
    }
  } finally {
    let cleaned = true
    if (composePath && workspace) {
      try {
        const down = await executor(
          binary,
          [
            'compose',
            '--project-name',
            project,
            '--file',
            composePath,
            'down',
            '--volumes',
            '--remove-orphans',
            '--timeout',
            '5',
          ],
          { cwd: workspace, timeoutMs: 20000, maxBufferBytes: 256 * 1024, env: dockerEnv() },
        )
        cleaned = down.exitCode === 0
      } catch {
        cleaned = false
      }
    }
    if (workspace) {
      try {
        assertWithin(workspaceRoot, workspace)
        fs.rmSync(workspace, { force: true, recursive: true })
      } catch {
        cleaned = false
      }
      result.cleanupStatus = cleaned ? 'cleaned' : 'cleanup_failed'
    }
    if (cleaned && journalPath) {
      try {
        fs.rmSync(journalPath, { force: true })
      } catch {
        result.cleanupStatus = 'cleanup_failed'
      }
    } else if (journalPath) {
      try {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as CleanupJournal
        journal.state = 'cleanup_failed'
        journal.expiresAt = 0
        const temp = `${journalPath}.${crypto.randomUUID()}.tmp`
        fs.writeFileSync(temp, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
        fs.renameSync(temp, journalPath)
      } catch {
        result.cleanupStatus = 'cleanup_failed'
      }
    }
  }
  return result
}
