import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { parseDocument } from 'yaml'
import { ORIGINAL_D02_EXECUTION_PROFILE, ORIGINAL_D02_TIMEOUT_MS } from './modelCallBudget.js'

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const EVALUATION_PACKAGE_ROOT = path.resolve(
  process.env.EVALUATION_PACKAGE_ROOT || path.join(SERVICE_ROOT, 'evaluation-packages'),
)
export const EVALUATION_EXAMPLE_ROOT = path.join(SERVICE_ROOT, 'evaluation-examples')
export function evaluationArchiveLimits(profile = process.env.EVALUATION_ARCHIVE_PROFILE) {
  if (profile && profile !== 'default' && profile !== 'course-v3')
    throw new Error('EVALUATION_ARCHIVE_PROFILE must be default or course-v3')
  // Curated course packages contain real COCO/BERT weights and self-test fixtures.
  // This deployment setting only changes administrator package uploads; student
  // submissions retain their separately enforced per-question material limits.
  const largeCourse = profile === 'course-v3'
  return {
    compressedBytes: (largeCourse ? 640 : 64) * 1024 * 1024,
    expandedBytes: (largeCourse ? 1536 : 512) * 1024 * 1024,
    fileBytes: (largeCourse ? 512 : 128) * 1024 * 1024,
    entries: 2000,
    ratio: 200,
  }
}
export const ARCHIVE_LIMITS = evaluationArchiveLimits()
export type EvaluationPhase = 'basic' | 'baseline' | 'opponent'
export interface EvaluationManifest {
  schemaVersion: 1
  protocol: 'platform-rpc-v1'
  name: string
  image: string
  entrypoint: string
  phases: EvaluationPhase[]
  network: 'none' | 'gateway'
  resources: { cpus: number; memoryMb: number; pids: number; timeoutMs: number; tmpMb: number }
  materials: { requiresWeights: boolean; maxWeightBytes: number; maxCodeBytes: number }
  rpc: {
    maxRequestBytes: number
    maxResponseBytes: number
    maxArrayBytes?: number
    maxCalls?: number
    maxObjects?: number
  }
  worker?: { bootstrap?: string; files: string[] }
  executionProfile?: typeof ORIGINAL_D02_EXECUTION_PROFILE
}
export interface EvaluationPackage {
  id: string
  name: string
  digest: string
  createdAt: string
  manifest: EvaluationManifest
  valid: true
}
interface StoredPackage extends EvaluationPackage {
  files: Record<string, string>
}
export class PackageValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageValidationError'
  }
}
function fail(message: string): never {
  throw new PackageValidationError(message)
}
export function assertWithin(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('路径必须位于指定目录内')
}
export function safeRelativeName(name: string): string {
  if (!name || name.length > 240 || /[\\\x00-\x1f<>:"|?*]/.test(name) || name.startsWith('/'))
    fail('压缩包包含不安全路径')
  const clean = name.endsWith('/') ? name.slice(0, -1) : name
  const parts = clean.split('/')
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    fail('压缩包包含不安全路径')
  if (clean === '_metadata.json' || clean.startsWith('_self-tests/')) fail('压缩包包含平台保留路径')
  return clean
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须为对象`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail(`${label}包含不支持的字段`)
}
function number(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  integer = false,
): number {
  const n = value === undefined ? fallback : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    fail(`${label}超出允许范围`)
  return n
}
export function approvedEvaluationImages(): string[] {
  const configured = process.env.EVALUATION_ALLOWED_IMAGES?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return configured?.length ? configured : ['python:3.12-slim', 'python:3.11-slim']
}
export function validateManifest(
  raw: unknown,
  allowedImages = approvedEvaluationImages(),
): EvaluationManifest {
  const m = object(raw, 'manifest')
  keys(
    m,
    [
      'schemaVersion',
      'protocol',
      'name',
      'image',
      'entrypoint',
      'phases',
      'network',
      'resources',
      'materials',
      'rpc',
      'worker',
      'executionProfile',
    ],
    'manifest',
  )
  if (m.schemaVersion !== 1) fail('只支持环境包格式版本1')
  if (m.protocol !== 'platform-rpc-v1')
    fail('环境包必须使用platform-rpc-v1隔离调用协议，旧版直接导入学生代码须迁移')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120) fail('环境包名称无效')
  if (typeof m.image !== 'string' || !allowedImages.includes(m.image)) fail('镜像尚未加入平台允许列表')
  if (process.env.EVALUATION_REQUIRE_IMAGE_DIGEST === '1' && !/@sha256:[0-9a-f]{64}$/.test(m.image))
    fail('生产评测镜像必须绑定sha256摘要')
  const entrypoint = safeRelativeName(typeof m.entrypoint === 'string' ? m.entrypoint : 'main.py')
  if (!entrypoint.endsWith('.py')) fail('评测入口必须为Python脚本')
  if (
    !Array.isArray(m.phases) ||
    !m.phases.length ||
    m.phases.some((p) => !['basic', 'baseline', 'opponent'].includes(p))
  )
    fail('评测阶段配置无效')
  const network = m.network ?? 'none'
  if (network !== 'none' && network !== 'gateway') fail('只允许无网络或受控模型网关')
  if (m.executionProfile !== undefined && (m.executionProfile !== ORIGINAL_D02_EXECUTION_PROFILE ||
      network !== 'gateway' || JSON.stringify([...new Set(m.phases)].sort()) !== '["baseline","opponent"]'))
    fail('D02执行配置无效')
  const r = object(m.resources ?? {}, 'resources')
  keys(r, ['cpus', 'memoryMb', 'pids', 'timeoutMs', 'tmpMb'], 'resources')
  const t = object(m.materials ?? {}, 'materials')
  const rpc = object(m.rpc ?? {}, 'rpc')
  keys(rpc, ['maxRequestBytes', 'maxResponseBytes', 'maxArrayBytes', 'maxCalls', 'maxObjects'], 'rpc')
  keys(t, ['requiresWeights', 'maxWeightBytes', 'maxCodeBytes'], 'materials')
  if (t.requiresWeights !== undefined && typeof t.requiresWeights !== 'boolean')
    fail('requiresWeights必须为布尔值')
  let worker: EvaluationManifest['worker']
  if (m.worker !== undefined) {
    const w = object(m.worker, 'worker')
    keys(w, ['bootstrap', 'files'], 'worker')
    if (!Array.isArray(w.files) || w.files.length > 256) fail('worker公开文件必须是最多256项的列表')
    const files = w.files.map((name: unknown) => {
      if (typeof name !== 'string') fail('worker公开文件路径无效')
      const file = safeRelativeName(name)
      if (!file.startsWith('public/') || name.endsWith('/')) fail('worker只能访问public目录内显式声明的文件')
      return file
    })
    if (new Set(files.map((name) => name.toLowerCase())).size !== files.length)
      fail('worker公开文件存在重复路径')
    worker = { files }
    if (w.bootstrap !== undefined) {
      if (typeof w.bootstrap !== 'string' || !w.bootstrap.endsWith('.py') || !files.includes(w.bootstrap))
        fail('worker bootstrap必须是公开文件列表中的Python文件')
      worker.bootstrap = w.bootstrap
    }
  }
  return {
    schemaVersion: 1,
    protocol: 'platform-rpc-v1',
    name: m.name.trim(),
    image: m.image,
    entrypoint,
    phases: [...new Set(m.phases)] as EvaluationPhase[],
    network,
    resources: {
      cpus: number(r.cpus, 1, 0.1, 8, 'CPU'),
      memoryMb: number(r.memoryMb, 512, 64, 16384, '内存', true),
      pids: number(r.pids, 64, 8, 512, '进程数', true),
      timeoutMs: number(r.timeoutMs, 120000, 100, m.executionProfile === ORIGINAL_D02_EXECUTION_PROFILE ? ORIGINAL_D02_TIMEOUT_MS : 3600000, '超时', true),
      tmpMb: number(r.tmpMb, 64, 8, 1024, '临时存储', true),
    },
    materials: {
      requiresWeights: t.requiresWeights === true,
      maxWeightBytes: number(t.maxWeightBytes, 500 * 1024 * 1024, 1, 2 * 1024 ** 3, '参数文件大小', true),
      maxCodeBytes: number(t.maxCodeBytes, 1024 * 1024, 1, 10 * 1024 * 1024, '代码大小', true),
    },
    rpc: {
      maxRequestBytes: number(rpc.maxRequestBytes, 1024 * 1024, 1024, 256 * 1024 * 1024, 'RPC请求大小', true),
      maxResponseBytes: number(
        rpc.maxResponseBytes,
        1024 * 1024,
        1024,
        256 * 1024 * 1024,
        'RPC响应大小',
        true,
      ),
      // Do not add defaults to old manifests: their normalized shape is part of the immutable package record.
      ...(rpc.maxArrayBytes === undefined
        ? {}
        : {
            maxArrayBytes: number(
              rpc.maxArrayBytes,
              64 * 1024 * 1024,
              1024,
              128 * 1024 * 1024,
              'RPC数组大小',
              true,
            ),
          }),
      ...(rpc.maxCalls === undefined
        ? {}
        : {
            maxCalls: number(rpc.maxCalls, 4096, 1, 100000, 'RPC调用次数', true),
          }),
      ...(rpc.maxObjects === undefined
        ? {}
        : {
            maxObjects: number(rpc.maxObjects, 64, 1, 256, 'RPC对象数', true),
          }),
    },
    ...(worker === undefined ? {} : { worker }),
    ...(m.executionProfile === undefined ? {} : { executionProfile: ORIGINAL_D02_EXECUTION_PROFILE }),
  }
}
/** Uploaded Compose is a declaration, never the executed document. All mounts/network/privileges are generated by the platform. */
export function validateComposeDeclaration(text: string, manifest: EvaluationManifest): void {
  const doc = parseDocument(text, { uniqueKeys: true })
  if (doc.errors.length || doc.warnings.length) fail('Compose格式错误或包含不支持的标签')
  let parsed: unknown
  try {
    parsed = doc.toJS({ maxAliasCount: 0 })
  } catch {
    fail('Compose不允许别名展开')
  }
  const c = object(parsed, 'Compose')
  keys(c, ['services', 'version'], 'Compose')
  const services = object(c.services, 'services')
  keys(services, ['evaluator'], 'services')
  const service = object(services.evaluator, 'evaluator')
  keys(service, ['image', 'command', 'working_dir', 'environment'], 'evaluator')
  if (service.image !== manifest.image) fail('Compose镜像与manifest不一致')
  if (service.working_dir !== undefined && service.working_dir !== '/package') fail('工作目录必须为/package')
  if (
    service.command !== undefined &&
    JSON.stringify(service.command) !== JSON.stringify(['python', `/package/${manifest.entrypoint}`])
  )
    fail('评测命令由平台固定生成')
  if (service.environment !== undefined) {
    const env = object(service.environment, 'environment')
    keys(env, ['PYTHONUTF8', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE'], 'environment')
    if (Object.values(env).some((v) => String(v) !== '1')) fail('不允许覆写运行时环境')
  }
}
function sha(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
export function decodeEvaluationArchive(buffer: Buffer): Map<string, Buffer> {
  if (!buffer.length || buffer.length > ARCHIVE_LIMITS.compressedBytes) fail('环境包压缩大小超限')
  // Bound the central-directory count before the ZIP library allocates entry objects. ZIP64/multidisk is unnecessary within these size limits.
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i
      break
    }
  }
  if (end < 0) fail('环境包不是完整ZIP')
  const count = buffer.readUInt16LE(end + 10)
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    buffer.readUInt16LE(end + 8) !== count ||
    count < 1 ||
    count > ARCHIVE_LIMITS.entries
  )
    fail('压缩包文件数量或分卷格式不允许')
  const centralOffset = buffer.readUInt32LE(end + 16),
    centralBytes = buffer.readUInt32LE(end + 12)
  if (centralOffset + centralBytes > end) fail('ZIP目录范围无效')
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    fail('环境包不是有效ZIP')
  }
  const entries = zip.getEntries()
  if (!entries.length || entries.length > ARCHIVE_LIMITS.entries) fail('压缩包文件数量超限')
  let total = 0
  const names = new Set<string>()
  const files = new Map<string, Buffer>()
  for (const entry of entries) {
    const name = safeRelativeName(entry.entryName)
    const collision = name.toLowerCase()
    if (names.has(collision)) fail('压缩包存在重复路径')
    names.add(collision)
    const mode = (entry.header.attr >>> 16) & 0xf000
    if (mode && mode !== 0x8000 && mode !== 0x4000) fail('压缩包不允许符号链接或特殊文件')
    if (entry.header.flags & 1) fail('压缩包不允许加密文件')
    if (entry.isDirectory) continue
    const size = entry.header.size
    const compressed = entry.header.compressedSize
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > ARCHIVE_LIMITS.fileBytes ||
      total + size > ARCHIVE_LIMITS.expandedBytes
    )
      fail('解压后大小超限')
    if (size > 1024 * 1024 && size > Math.max(1, compressed) * ARCHIVE_LIMITS.ratio) fail('压缩率超限')
    if (![0, 8].includes(entry.header.method)) fail('不支持的ZIP压缩方法')
    let data: Buffer
    try {
      const packed = entry.getCompressedData()
      data =
        entry.header.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) })
    } catch {
      fail('ZIP数据损坏或解压大小超限')
    }
    if (data.length !== size || crc32(data) !== entry.header.crc >>> 0) fail('ZIP大小或CRC校验失败')
    total += data.length
    files.set(name, data)
  }
  if (!files.has('manifest.json') || !files.has('compose.yaml'))
    fail('环境包根目录缺少manifest.json或compose.yaml')
  return files
}
function publicPackage(stored: StoredPackage): EvaluationPackage {
  const { files: _files, ...metadata } = stored
  return metadata
}
function validateFiles(files: Map<string, Buffer>): EvaluationManifest {
  let raw: unknown
  try {
    raw = JSON.parse(files.get('manifest.json')?.toString('utf8') || '')
  } catch {
    fail('manifest.json格式错误')
  }
  const manifest = validateManifest(raw)
  if (!files.has(manifest.entrypoint)) fail('评测入口不存在')
  for (const name of manifest.worker?.files ?? []) {
    if (!files.has(name)) fail(`worker公开文件不存在：${name}`)
  }
  validateComposeDeclaration(files.get('compose.yaml')?.toString('utf8') || '', manifest)
  return manifest
}
export function packageDirectory(id: string, root = EVALUATION_PACKAGE_ROOT): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) fail('环境包ID无效')
  const directory = path.resolve(root, id)
  assertWithin(root, directory)
  return directory
}
function storeFiles(files: Map<string, Buffer>, root: string): EvaluationPackage {
  const manifest = validateFiles(files)
  fs.mkdirSync(root, { recursive: true })
  const id = crypto.randomUUID()
  const directory = packageDirectory(id, root)
  const hashes = Object.fromEntries([...files].map(([name, data]) => [name, sha(data)]))
  const stored: StoredPackage = {
    id,
    name: manifest.name,
    manifest,
    digest: sha(JSON.stringify(hashes)),
    createdAt: new Date().toISOString(),
    valid: true,
    files: hashes,
  }
  try {
    fs.mkdirSync(directory)
    for (const [name, data] of files) {
      const target = path.resolve(directory, name)
      assertWithin(directory, target)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data, { flag: 'wx', mode: 0o444 })
    }
    fs.writeFileSync(path.join(directory, '_metadata.json'), JSON.stringify(stored, null, 2), {
      flag: 'wx',
      mode: 0o444,
    })
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true })
    throw error
  }
  return publicPackage(stored)
}
export async function importEvaluationArchive(
  buffer: Buffer,
  root = EVALUATION_PACKAGE_ROOT,
): Promise<EvaluationPackage> {
  return storeFiles(decodeEvaluationArchive(buffer), root)
}
export async function importEvaluationDirectory(
  directory: string,
  root = EVALUATION_PACKAGE_ROOT,
): Promise<EvaluationPackage> {
  const files = new Map<string, Buffer>()
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        fail('环境包不允许链接或特殊文件')
      if (entry.isDirectory()) walk(p)
      else
        files.set(safeRelativeName(path.relative(directory, p).split(path.sep).join('/')), fs.readFileSync(p))
    }
  }
  walk(directory)
  return storeFiles(files, root)
}
export async function readEvaluationPackage(
  id: string,
  root = EVALUATION_PACKAGE_ROOT,
): Promise<EvaluationPackage> {
  const directory = packageDirectory(id, root)
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) fail('环境包不存在')
  let stored: StoredPackage
  try {
    stored = JSON.parse(fs.readFileSync(path.join(directory, '_metadata.json'), 'utf8')) as StoredPackage
  } catch {
    fail('环境包元数据不可用')
  }
  if (stored.id !== id || !stored.files || typeof stored.files !== 'object') fail('环境包元数据损坏')
  const files = new Map<string, Buffer>()
  for (const [name, hash] of Object.entries(stored.files)) {
    safeRelativeName(name)
    const file = path.resolve(directory, name)
    assertWithin(directory, file)
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())
      fail('环境包文件失效')
    assertWithin(directory, fs.realpathSync(file))
    const data = fs.readFileSync(file)
    if (sha(data) !== hash) fail('环境包文件被修改')
    files.set(name, data)
  }
  const manifest = validateFiles(files)
  if (
    sha(JSON.stringify(stored.files)) !== stored.digest ||
    JSON.stringify(manifest) !== JSON.stringify(stored.manifest)
  )
    fail('环境包摘要不一致')
  return publicPackage(stored)
}
export async function listEvaluationPackages(root = EVALUATION_PACKAGE_ROOT): Promise<EvaluationPackage[]> {
  if (!fs.existsSync(root)) return []
  const result: EvaluationPackage[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      result.push(await readEvaluationPackage(entry.name, root))
    } catch {
      /* Invalid packages cannot be selected or published. */
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const getEvaluationPackage = readEvaluationPackage

export async function snapshotEvaluationPackage(
  id: string,
  destination: string,
  root = EVALUATION_PACKAGE_ROOT,
): Promise<EvaluationPackage> {
  const descriptor = await readEvaluationPackage(id, root)
  const source = packageDirectory(id, root)
  const stored = JSON.parse(fs.readFileSync(path.join(source, '_metadata.json'), 'utf8')) as StoredPackage
  fs.mkdirSync(destination, { recursive: true })
  for (const [name, hash] of Object.entries(stored.files)) {
    const data = fs.readFileSync(path.join(source, name))
    if (sha(data) !== hash) fail('环境包在快照过程中被修改')
    const target = path.resolve(destination, name)
    assertWithin(destination, target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o444 })
  }
  return descriptor
}
