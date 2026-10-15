import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  decodeEvaluationArchive,
  importEvaluationArchive,
  importEvaluationDirectory,
  readEvaluationPackage,
  validateManifest,
  validateComposeDeclaration,
  EVALUATION_EXAMPLE_ROOT,
} from '../src/lib/evaluationPackage.js'

const manifest = {
  schemaVersion: 1,
  protocol: 'platform-rpc-v1',
  name: 'test',
  image: 'python:3.12-slim',
  entrypoint: 'main.py',
  phases: ['basic'],
}
function archive(extra: Array<[string, Buffer]> = []): AdmZip {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('compose.yaml', Buffer.from('services:\n  evaluator:\n    image: python:3.12-slim\n'))
  zip.addFile('main.py', Buffer.from('print("trusted entry")'))
  for (const [name, data] of extra) zip.addFile(name, data)
  return zip
}
test('valid ZIP package is immutable and checked again when selected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-package-'))
  try {
    const descriptor = await importEvaluationArchive(archive().toBuffer(), root)
    assert.equal(descriptor.valid, true)
    assert.equal((await readEvaluationPackage(descriptor.id, root)).digest, descriptor.digest)
    fs.chmodSync(path.join(root, descriptor.id, 'main.py'), 0o644)
    fs.writeFileSync(path.join(root, descriptor.id, 'main.py'), 'tampered')
    await assert.rejects(readEvaluationPackage(descriptor.id, root), /被修改/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('ZIP traversal, absolute paths, Windows alternate streams and ambiguous paths are rejected', () => {
  for (const name of [
    '../outside.py',
    '/outside.py',
    'C:/outside.py',
    'safe\\..\\outside.py',
    'a:stream',
    'AUX.txt',
    'a./file.py',
  ]) {
    const zip = archive()
    zip.addFile('placeholder.py', Buffer.from('x'))
    // Assign directly to preserve unsafe names that ZIP writers sometimes normalize.
    zip.getEntry('placeholder.py')!.entryName = name
    assert.throws(() => decodeEvaluationArchive(zip.toBuffer()), /不安全路径/, name)
  }
})
test('ZIP symbolic links and case-folding duplicate entries are rejected', () => {
  const zip = archive([['link.py', Buffer.from('/etc/passwd')]])
  zip.getEntry('link.py')!.header.attr = (0o120777 << 16) >>> 0
  assert.throws(() => decodeEvaluationArchive(zip.toBuffer()), /链接|特殊文件/)
  assert.throws(
    () =>
      decodeEvaluationArchive(
        archive([
          ['A.py', Buffer.from('x')],
          ['a.py', Buffer.from('y')],
        ]).toBuffer(),
      ),
    /重复路径/,
  )
})
test('ZIP bombs and forged uncompressed lengths are rejected before unbounded expansion', () => {
  const bomb = archive([['bomb.data', Buffer.alloc(2 * 1024 * 1024)]])
  assert.throws(() => decodeEvaluationArchive(bomb.toBuffer()), /压缩率超限/)
  const lied = archive([['lie.data', Buffer.alloc(512 * 1024, 0x41)]])
  const buffer = lied.toBuffer()
  // Change only central-directory uncompressed size; the bounded inflater must reject the actual oversized payload.
  let position = 0
  while (position < buffer.length - 46) {
    if (buffer.readUInt32LE(position) === 0x02014b50) {
      const length = buffer.readUInt16LE(position + 28)
      if (buffer.subarray(position + 46, position + 46 + length).toString() === 'lie.data') {
        buffer.writeUInt32LE(1, position + 24)
        break
      }
    }
    position++
  }
  assert.throws(() => decodeEvaluationArchive(buffer), /损坏|大小/)
})
test('Compose declaration rejects privilege, host network, docker socket, builds and injected commands', () => {
  const valid = validateManifest(manifest)
  for (const [key, value] of [
    ['privileged', 'true'],
    ['network_mode', 'host'],
    ['volumes', '[/var/run/docker.sock:/var/run/docker.sock]'],
    ['build', '.'],
    ['cap_add', '[SYS_ADMIN]'],
    ['devices', '[/dev/sda]'],
    ['entrypoint', '/bin/sh'],
    ['ports', '[8080:8080]'],
  ])
    assert.throws(
      () =>
        validateComposeDeclaration(
          `services:\n  evaluator:\n    image: python:3.12-slim\n    ${key}: ${value}\n`,
          valid,
        ),
      /不支持/,
    )
  assert.throws(
    () =>
      validateComposeDeclaration(
        'services:\n  evaluator:\n    image: python:3.12-slim\n    command: [sh, -c, echo hacked]\n',
        valid,
      ),
    /固定生成/,
  )
  assert.throws(
    () =>
      validateComposeDeclaration(
        'services:\n  evaluator:\n    image: python:3.12-slim\n    environment:\n      DATABASE_URL: anything\n',
        valid,
      ),
    /不支持/,
  )
  assert.throws(
    () =>
      validateComposeDeclaration(
        'services:\n  evaluator:\n    image: python:3.12-slim\n    image: python:3.11-slim\n',
        valid,
      ),
    /格式错误/,
  )
})
test('manifest enforces approved images, bounded resources and finite limits', () => {
  assert.throws(() => validateManifest({ ...manifest, image: 'untrusted/host-tool:latest' }), /允许列表/)
  assert.throws(() => validateManifest({ ...manifest, resources: { cpus: Infinity } }), /允许范围/)
  assert.throws(() => validateManifest({ ...manifest, resources: { memoryMb: 1000000 } }), /允许范围/)
  assert.throws(() => validateManifest({ ...manifest, entrypoint: '../main.py' }), /不安全路径/)
})
test('real teaching example packages all validate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-examples-'))
  try {
    for (const name of ['basic-algorithm', 'model-inference', 'attack-defense']) {
      const descriptor = await importEvaluationDirectory(path.join(EVALUATION_EXAMPLE_ROOT, name), root)
      assert.equal((await readEvaluationPackage(descriptor.id, root)).valid, true)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('legacy manifests keep their original normalized shape and extended RPC limits stay bounded', () => {
  const old = validateManifest(manifest)
  assert.deepEqual(old.rpc, { maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024 })
  assert.equal('worker' in old, false)
  const extended = validateManifest({
    ...manifest,
    resources: { timeoutMs: 3600000 },
    rpc: {
      maxRequestBytes: 128 * 1024 ** 2,
      maxResponseBytes: 128 * 1024 ** 2,
      maxArrayBytes: 64 * 1024 ** 2,
      maxCalls: 10000,
      maxObjects: 128,
    },
  })
  assert.equal(extended.resources.timeoutMs, 3600000)
  assert.equal(extended.rpc.maxObjects, 128)
  for (const rpc of [
    { maxArrayBytes: 128 * 1024 ** 2 + 1 },
    { maxCalls: 100001 },
    { maxObjects: 257 },
    { maxRequestBytes: 256 * 1024 ** 2 + 1 },
    { maxResponseBytes: Infinity },
    { maxCalls: 1.5 },
  ])
    assert.throws(() => validateManifest({ ...manifest, rpc }), /允许范围/)
  assert.throws(() => validateManifest({ ...manifest, resources: { timeoutMs: 3600001 } }), /允许范围/)
})

test('worker exposes only existing explicitly named public files and a declared bootstrap', async () => {
  const worker = { bootstrap: 'public/bootstrap.py', files: ['public/bootstrap.py', 'public/helper.py'] }
  assert.deepEqual(validateManifest({ ...manifest, worker }).worker, {
    files: worker.files,
    bootstrap: worker.bootstrap,
  })
  for (const invalid of [
    { files: ['main.py'] },
    { files: ['public/../main.py'] },
    { files: ['public/'] },
    { files: ['public/a.py', 'public/A.py'] },
    { files: ['public/helper.py'], bootstrap: 'public/bootstrap.py' },
    { files: ['public/model.bin'], bootstrap: 'public/model.bin' },
    { files: ['public/helper.py'], hidden: true },
  ])
    assert.throws(() => validateManifest({ ...manifest, worker: invalid }))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-worker-public-'))
  try {
    const zip = archive()
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, worker })))
    await assert.rejects(importEvaluationArchive(zip.toBuffer(), root), /公开文件不存在/)
    zip.addFile('public/bootstrap.py', Buffer.from('def load_student(path): pass'))
    zip.addFile('public/helper.py', Buffer.from('PUBLIC = True'))
    const imported = await importEvaluationArchive(zip.toBuffer(), root)
    assert.deepEqual((await readEvaluationPackage(imported.id, root)).manifest.worker, {
      files: worker.files,
      bootstrap: worker.bootstrap,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
