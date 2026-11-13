import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishedReference, referenceFilename } from '../src/services/publishedReferences.js'

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-security-'))
  const references = path.join(root, 'references')
  const packages = path.join(root, 'packages')
  const pkg = path.join(packages, 'pkg')
  const links: string[] = []
  fs.mkdirSync(references)
  fs.mkdirSync(pkg, { recursive: true })
  const source = 'def baseline():\n    return None\n'
  fs.writeFileSync(path.join(pkg, 'runtime.py'), source)
  const question = {
    id: 'A28',
    revision: 1,
    evaluationVersion: 'v1',
    category: 'adversarial',
    role: 'attack',
    definition: JSON.stringify({ evaluation: { packageId: 'pkg' } }),
  }
  const record = {
    schemaVersion: 1,
    questionId: question.id,
    questionVersion: question.revision,
    evaluationVersion: question.evaluationVersion,
    definitionDigest: sha(question.definition),
    packageId: 'pkg',
    packageDigest: '',
    referenceKind: 'qualification',
    title: '实际基线',
    explanation: '审核后的公开节选',
    code: source,
    codeSha256: sha(source),
    sourceFiles: [{ path: 'runtime.py', sha256: sha(source) }],
    publishedAt: '2026-11-13T00:00:00Z',
  }
  const artifact = path.join(references, referenceFilename(question.id))
  const save = () => {
    const files = Object.fromEntries(record.sourceFiles.map((file) => [file.path, file.sha256]))
    record.packageDigest = sha(JSON.stringify(files))
    fs.writeFileSync(
      path.join(pkg, '_metadata.json'),
      JSON.stringify({ id: 'pkg', valid: true, files, digest: record.packageDigest }),
    )
    fs.writeFileSync(artifact, JSON.stringify(record))
  }
  save()
  return {
    root,
    references,
    packages,
    pkg,
    source,
    record,
    artifact,
    save,
    read: () => publishedReference(question, { root: references, packageRoot: packages }),
    link: (target: string, destination: string) => {
      fs.symlinkSync(target, destination, 'junction')
      links.push(destination)
    },
    close: () => {
      for (const link of links) fs.unlinkSync(link)
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function assertHidden(result: Awaited<ReturnType<typeof publishedReference>>) {
  assert.equal(result.item, null)
  assert.match(result.notice, /正在核对/)
  assert.doesNotMatch(result.notice, /PRIVATE|reference-security|runtime|pkg|ENOENT|EISDIR|stack/)
}

test('reference source paths reject traversal, Windows paths and duplicate sources even with matching manifests', async () => {
  const f = fixture()
  try {
    assert.ok((await f.read()).item)
    for (const name of [
      '../PRIVATE.py',
      '/PRIVATE.py',
      'C:/PRIVATE.py',
      'a\\PRIVATE.py',
      'a/../PRIVATE.py',
      'a//PRIVATE.py',
      'NUL.py',
    ]) {
      f.record.sourceFiles = [{ path: name, sha256: sha(f.source) }]
      f.save()
      assertHidden(await f.read())
    }
    f.record.sourceFiles = new Array(2).fill({ path: 'runtime.py', sha256: sha(f.source) })
    f.save()
    assertHidden(await f.read())
  } finally {
    f.close()
  }
})

test('publication, metadata and individual source byte caps fail closed without returning private bytes', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(f.artifact, JSON.stringify({ ...f.record, padding: 'x'.repeat(1024 * 1024) }))
    assertHidden(await f.read())
    f.save()
    fs.appendFileSync(path.join(f.pkg, '_metadata.json'), ' '.repeat(512 * 1024))
    assertHidden(await f.read())
    const largeSource = '# PRIVATE\n' + 'x'.repeat(2 * 1024 * 1024)
    fs.writeFileSync(path.join(f.pkg, 'runtime.py'), largeSource)
    f.record.sourceFiles = [{ path: 'runtime.py', sha256: sha(largeSource) }]
    f.save()
    assertHidden(await f.read())
    f.record.sourceFiles = new Array(25).fill({ path: 'runtime.py', sha256: sha(f.source) })
    f.save()
    assertHidden(await f.read())
  } finally {
    f.close()
  }
})

test('package and nested source directory links are rejected even when the target and hashes are valid', async () => {
  for (const location of ['package', 'source']) {
    const f = fixture()
    try {
      const target = path.join(f.root, 'PRIVATE')
      if (location === 'package') {
        fs.renameSync(f.pkg, target)
        f.link(target, f.pkg)
      } else {
        fs.mkdirSync(target)
        fs.renameSync(path.join(f.pkg, 'runtime.py'), path.join(target, 'runtime.py'))
        f.link(target, path.join(f.pkg, 'linked'))
        f.record.sourceFiles = [{ path: 'linked/runtime.py', sha256: sha(f.source) }]
        f.save()
      }
      assertHidden(await f.read())
    } finally {
      f.close()
    }
  }
})
