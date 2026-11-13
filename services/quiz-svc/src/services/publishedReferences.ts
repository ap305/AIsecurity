import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Question } from '@prisma/client'
import { EVALUATION_PACKAGE_ROOT, packageDirectory, safeRelativeName } from '../lib/evaluationPackage.js'

type Binding = Pick<Question, 'id' | 'revision' | 'evaluationVersion' | 'definition' | 'category' | 'role'>
const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export const referenceFilename = (questionId: string) => `${sha(questionId)}.json`
const absent = '当前版本的实际评测基线尚未发布。教师补充讲解不会替换评测基线。'
const invalid = '实际评测基线资料正在核对，暂不展示；正常提交与评测不受影响。'

async function boundedFile(root: string, relative: string, maxBytes: number) {
  const absoluteRoot = await fs.realpath(root)
  let target = absoluteRoot
  for (const component of relative.split('/')) {
    if (!component || component === '.' || component === '..' || component.includes('\\'))
      throw new Error('invalid path')
    target = path.join(target, component)
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('invalid link')
  }
  const handle = await fs.open(target, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid size')
    // Read at most the limit + 1 even if an administrator accidentally replaces a file concurrently.
    const data = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead !== stat.size) throw new Error('file changed')
    return data.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max
}

/** Read only an administrator-reviewed publication tied to the exact live evaluator.
 * No request can select arbitrary private package paths or publish an evaluator.
 * Publication artifacts contain AST-selected code, never datasets or model weights.
 */
export async function publishedReference(
  question: Binding,
  options: { root?: string; packageRoot?: string } = {},
) {
  const root =
    options.root ?? process.env.PUBLISHED_REFERENCE_ROOT ?? path.join(serviceRoot, 'published-references')
  const packageRoot = options.packageRoot ?? EVALUATION_PACKAGE_ROOT
  let raw: Buffer
  try {
    raw = await boundedFile(root, referenceFilename(question.id), 1024 * 1024)
  } catch (error) {
    return { item: null, notice: (error as NodeJS.ErrnoException).code === 'ENOENT' ? absent : invalid }
  }
  try {
    const r = JSON.parse(raw.toString('utf8'))
    const def = JSON.parse(question.definition)
    if (
      r.schemaVersion !== 1 ||
      r.questionId !== question.id ||
      r.questionVersion !== question.revision ||
      r.evaluationVersion !== question.evaluationVersion ||
      r.definitionDigest !== sha(question.definition) ||
      r.packageId !== def.evaluation?.packageId ||
      !digest(r.packageDigest) ||
      r.referenceKind !== 'qualification' ||
      !text(r.title, 500) ||
      !r.title.trim() ||
      !text(r.explanation, 32 * 1024) ||
      !text(r.code, 256 * 1024) ||
      !r.code.trim() ||
      !digest(r.codeSha256) ||
      sha(r.code) !== r.codeSha256 ||
      !Array.isArray(r.sourceFiles) ||
      r.sourceFiles.length < 1 ||
      r.sourceFiles.length > 24 ||
      typeof r.publishedAt !== 'string' ||
      !Number.isFinite(Date.parse(r.publishedAt))
    )
      throw new Error('invalid publication')
    const directory = packageDirectory(r.packageId, packageRoot)
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('invalid package')
    const meta = JSON.parse((await boundedFile(directory, '_metadata.json', 512 * 1024)).toString('utf8'))
    if (
      meta.id !== r.packageId ||
      meta.valid !== true ||
      !meta.files ||
      Array.isArray(meta.files) ||
      meta.digest !== r.packageDigest ||
      sha(JSON.stringify(meta.files)) !== meta.digest
    )
      throw new Error('changed package')
    const seen = new Set<string>()
    for (const source of r.sourceFiles) {
      const name = safeRelativeName(source.path)
      if (
        seen.has(name) ||
        !name.endsWith('.py') ||
        !digest(source.sha256) ||
        meta.files[name] !== source.sha256
      )
        throw new Error('invalid source')
      seen.add(name)
      if (sha(await boundedFile(directory, name, 2 * 1024 * 1024)) !== source.sha256)
        throw new Error('changed source')
    }
    return {
      item: {
        id: `evaluation-${question.id}-${question.revision}`,
        title: r.title as string,
        explanation: r.explanation as string,
        code: r.code as string,
        kind: 'standard' as const,
        author: '当前评测基线',
        questionVersion: question.revision,
        source: 'evaluation' as const,
        referenceKind: 'qualification' as const,
        actualEvaluationReference: true,
        score: null,
        updating: false,
        emptyPool: false,
        notice: '已核对当前评测版本的实际资格基线。新基线须经校准与发布后更新；此处不改变对手池胜率计分。',
        needsModelAttachment: !!(def.weights?.required || def.weights?.enabled),
        canWithdraw: false,
        createdAt: new Date(r.publishedAt).toISOString(),
        sourceCreatedAt: null,
      },
      notice: '',
    }
  } catch {
    return { item: null, notice: invalid }
  }
}
