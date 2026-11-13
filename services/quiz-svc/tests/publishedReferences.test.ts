import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { publishedReference, referenceFilename } from '../src/services/publishedReferences.js'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-reference-'))
  const references = path.join(root, 'references'),
    packages = path.join(root, 'packages')
  fs.mkdirSync(references)
  fs.mkdirSync(path.join(packages, 'pkg'), { recursive: true })
  const source = 'def baseline():\n    return None\n'
  const files = { 'runtime.py': sha(source) }
  const meta = { id: 'pkg', valid: true, digest: sha(JSON.stringify(files)), files }
  fs.writeFileSync(path.join(packages, 'pkg', '_metadata.json'), JSON.stringify(meta))
  fs.writeFileSync(path.join(packages, 'pkg', 'runtime.py'), source)
  const question = {
    id: 'A28',
    revision: 3,
    evaluationVersion: 'version',
    category: 'adversarial',
    role: 'attack',
    definition: JSON.stringify({ evaluation: { packageId: 'pkg' }, weights: { required: false } }),
  }
  const data: any = {
    schemaVersion: 1,
    questionId: question.id,
    questionVersion: question.revision,
    evaluationVersion: question.evaluationVersion,
    definitionDigest: sha(question.definition),
    packageId: 'pkg',
    packageDigest: meta.digest,
    sourceFiles: [{ path: 'runtime.py', sha256: sha(source), nodes: ['baseline'] }],
    title: '当前无防御资格基线',
    explanation: '仅公开算法节选，数据不公开。',
    code: source,
    codeSha256: sha(source),
    referenceKind: 'qualification',
    publishedAt: '2026-11-13T00:00:00.000Z',
  }
  const save = () =>
    fs.writeFileSync(path.join(references, referenceFilename(question.id)), JSON.stringify(data))
  save()
  return {
    question,
    data,
    source,
    references,
    packages,
    save,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('actual references expose only reviewed code and public provenance for the current frozen question', async () => {
  const f = fixture()
  try {
    const result = await publishedReference(f.question, { root: f.references, packageRoot: f.packages })
    assert.equal(result.item?.actualEvaluationReference, true)
    assert.equal(result.item?.code, f.source)
    assert.equal(result.item?.canWithdraw, false)
    assert.equal(result.item?.source, 'evaluation')
    assert.doesNotMatch(
      JSON.stringify(result.item),
      /runtime\.py|sourceFiles|packageDigest|definitionDigest|sha256|pkg/,
    )
  } finally {
    f.close()
  }
})

test('definition, revision, version, package and source changes hide stale actual references', async () => {
  const f = fixture()
  try {
    for (const change of [
      { revision: 4 },
      { evaluationVersion: 'other' },
      { definition: f.question.definition + ' ' },
    ])
      assert.equal(
        (
          await publishedReference(
            { ...f.question, ...change },
            { root: f.references, packageRoot: f.packages },
          )
        ).item,
        null,
      )
    f.data.packageDigest = 'f'.repeat(64)
    f.save()
    assert.equal(
      (await publishedReference(f.question, { root: f.references, packageRoot: f.packages })).item,
      null,
    )
    f.data.packageDigest = JSON.parse(
      fs.readFileSync(path.join(f.packages, 'pkg', '_metadata.json'), 'utf8'),
    ).digest
    f.save()
    fs.writeFileSync(path.join(f.packages, 'pkg', 'runtime.py'), 'changed')
    assert.equal(
      (await publishedReference(f.question, { root: f.references, packageRoot: f.packages })).item,
      null,
    )
  } finally {
    f.close()
  }
})

test('missing, malformed, oversized and unsafe reference artifacts fail closed without private diagnostics', async () => {
  const f = fixture()
  try {
    for (const change of [
      { codeSha256: 'f'.repeat(64) },
      { sourceFiles: [{ path: '../private', sha256: 'f'.repeat(64), nodes: [] }] },
      { code: 'a'.repeat(256 * 1024 + 1) },
      { explanation: '\0secret' },
    ]) {
      const original = { ...f.data }
      Object.assign(f.data, change)
      f.save()
      const result = await publishedReference(f.question, { root: f.references, packageRoot: f.packages })
      assert.equal(result.item, null)
      assert.doesNotMatch(result.notice, /private|reference-|pkg|ENOENT|secret/)
      Object.assign(f.data, original)
    }
    fs.unlinkSync(path.join(f.references, referenceFilename(f.question.id)))
    assert.equal(
      (await publishedReference(f.question, { root: f.references, packageRoot: f.packages })).item,
      null,
    )
    assert.match(referenceFilename('../../private'), /^[a-f0-9]{64}\.json$/)
  } finally {
    f.close()
  }
})
