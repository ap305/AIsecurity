import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { RequestError, type QuestionDefinition } from '../lib/prdContract.js'

const scopes = new Set(['V3-261012-A02', 'V3-261012-D02', 'V3-261012-A09', 'V3-261012-D09'])
const policy = 'first-valid-response-v1'
export interface ResponseSnapshotContext {
  policy: string; scope: string; evaluationVersion: string; packageDigest: string
}
export function snapshotCallEvidence(record: any): { upstreamCalls: number; responseSnapshotHits: number } {
  if (![record.calls, record.upstreamCalls, record.responseSnapshotHits].every(v => Number.isSafeInteger(v) && v >= 0) ||
      record.calls < 1 || record.upstreamCalls + record.responseSnapshotHits !== record.calls)
    throw new Error('snapshot_call_evidence_invalid')
  return { upstreamCalls: record.upstreamCalls, responseSnapshotHits: record.responseSnapshotHits }
}
export function responseSnapshotContext(definition: QuestionDefinition, packageDigest: string): ResponseSnapshotContext | null {
  const params = definition.evaluation.parameters as Record<string, unknown> | undefined
  if (params?.responseSnapshotPolicy === undefined) return null
  if (params.responseSnapshotPolicy !== policy || !scopes.has(String(params.responseSnapshotScope)) ||
      !definition.evaluation.version || !/^[a-f0-9]{64}$/.test(packageDigest))
    throw new RequestError('响应快照配置无效', 400)
  return { policy, scope: String(params.responseSnapshotScope), evaluationVersion: definition.evaluation.version, packageDigest }
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v === undefined ? null : v)).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
const hash = (value: unknown) => crypto.createHash('sha256').update(canonical(value)).digest('hex')
const failure = () => new RequestError('可信模型响应快照不可用，本次不产生正式成绩', 502)
// The ranking course accepts an object after fence/extraction/trailing-comma
// repair. Mirror that admission test without changing score normalization.
function rankingObject(text: string): boolean {
  const raw = (/```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text).trim()
  const object = (body: string) => {
    try { const value = JSON.parse(body); return value !== null && typeof value === 'object' && !Array.isArray(value) } catch { return false }
  }
  if (object(raw)) return true
  const start = raw.indexOf('{'); if (start < 0) return false
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue }
    if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      const snippet = raw.slice(start, i + 1)
      return object(snippet) || object(snippet.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'))
    }
  }
  return false
}
function validResponse(response: any, scope: string): boolean {
  const message = response?.choices?.[0]?.message
  if (!message || typeof message !== 'object') return false
  const text = typeof message.content === 'string' && message.content.trim().length > 0
  const tools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.tool_calls.every((c: any) =>
    typeof c?.id === 'string' && c.id && typeof c?.function?.name === 'string' && c.function.name &&
    typeof c?.function?.arguments === 'string')
  if (scope.endsWith('02')) return Boolean(text && rankingObject(message.content))
  return Boolean(text || tools)
}
interface Options {
  root: string
  context: ResponseSnapshotContext
  binding: unknown
  payload: unknown
  call: () => Promise<any>
  beforeCall?: () => Promise<void>
  observe?: (source: 'upstream' | 'snapshot') => Promise<void>
  waitMs?: number
}
/** Private first-response storage. Caller must reserve its logical call budget
 * before entry; observe revalidates task activity before release/live inference.
 * A crash lock is never stolen or converted into an untracked upstream retry. */
export async function withResponseSnapshot(options: Options): Promise<any> {
  if (!options.root || !path.isAbsolute(options.root) || options.context.policy !== policy || !scopes.has(options.context.scope)) throw failure()
  const root = path.resolve(options.root)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(root)
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.resolve(await fs.realpath(root)) !== root) throw failure()
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())) throw failure()
  const domain = hash({ ...options.context, binding: options.binding }), request = hash(options.payload)
  const key = hash({ domain, request }), file = path.join(root, key + '.json'), lock = path.join(root, key + '.lock')
  async function read(): Promise<any | undefined> {
    let raw: string
    try {
      const info = await fs.lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw failure()
      raw = await fs.readFile(file, 'utf8')
    } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw failure() }
    try {
      const record = JSON.parse(raw)
      if (record.policy !== policy || record.domain !== domain || record.request !== request ||
          !validResponse(record.response, options.context.scope) || record.responseDigest !== hash(record.response)) throw failure()
      return record.response
    } catch { throw failure() }
  }
  const until = Date.now() + (options.waitMs ?? 65000)
  for (;;) {
    const cached = await read()
    if (cached !== undefined) { await options.observe?.('snapshot'); return cached }
    try { await fs.mkdir(lock, { mode: 0o700 }); break }
    catch (e: any) {
      if (e.code !== 'EEXIST' || Date.now() >= until) throw failure()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const temp = path.join(root, key + '.' + crypto.randomUUID() + '.tmp')
  try {
    const existing = await read()
    if (existing !== undefined) { await options.observe?.('snapshot'); return existing }
    await options.beforeCall?.()
    await options.observe?.('upstream')
    const response = await options.call()
    if (!validResponse(response, options.context.scope)) throw failure()
    const record = { policy, domain, request, response, responseDigest: hash(response), createdAt: new Date().toISOString() }
    const encoded = JSON.stringify(record)
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw failure()
    const fd = await fs.open(temp, 'wx', 0o600)
    try { await fd.writeFile(encoded); await fd.sync() } finally { await fd.close() }
    // Exclusive link preserves the first record even if an external trusted
    // writer unexpectedly published between the checks. Never overwrite it.
    try { await fs.link(temp, file) } catch (e: any) { if (e.code !== 'EEXIST') throw e }
    const stored = await read()
    if (stored === undefined) throw failure()
    return stored
  } finally {
    await fs.unlink(temp).catch((e: any) => { if (e.code !== 'ENOENT') throw e })
    await fs.rmdir(lock)
  }
}
