import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, base: string, token: string
const originalEmailEnabled = process.env.AUTH_EMAIL_ENABLED
async function json(path: string, body: unknown) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as any }
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  delete process.env.AUTH_EMAIL_ENABLED
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (prisma) await prisma.$disconnect()
  if (database) await database.close()
  if (originalEmailEnabled === undefined) delete process.env.AUTH_EMAIL_ENABLED
  else process.env.AUTH_EMAIL_ENABLED = originalEmailEnabled
})

test('gzip JSON is rejected before decompression with a fixed 415 envelope and the process remains healthy', async () => {
  for (const trailing of [Buffer.alloc(0), Buffer.from('private-trailing-bytes')]) {
    const response = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: Buffer.concat([gzipSync(Buffer.from('{"password":"PRIVATE_PASSWORD"}')), trailing]),
    })
    assert.equal(response.status, 415)
    const body: any = await response.json()
    assert.equal(body.code, 41501)
    assert.equal(body.data, null)
    assert.match(body.message, /不支持压缩.*JSON/)
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PASSWORD|trailing|zlib|stack/)
    const health = await fetch(base + '/health')
    assert.equal(health.status, 200)
    assert.equal(((await health.json()) as any).data.status, 'healthy')
  }
})

test('ordinary JSON registration and login still work after rejected compressed requests', async () => {
  const fields = {
    username: 'uncompressedstudent',
    displayName: '测试学生',
    password: 'uncompressed safe password 123',
  }
  assert.equal((await json('/auth/register', fields)).status, 200)
  const logged = await json('/auth/login', {
    username: fields.username,
    password: fields.password,
    role: 'student',
  })
  assert.equal(logged.status, 200)
  assert.equal(logged.body.data.user.username, fields.username)
  token = logged.body.data.token
})

test('invalid JSON syntax, oversize and ordinary field validation retain their existing 400 responses', async () => {
  for (const body of ['{', JSON.stringify({ code: 'x'.repeat(2 * 1024 * 1024 + 1) })]) {
    const response = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(response.status, 400)
    assert.equal(((await response.json()) as any).code, 40001)
  }
  const invalid = await json('/auth/register', {})
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.message, /用户名/)
  const unsupportedCharset = await fetch(base + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=PRIVATE_UNSUPPORTED_CHARSET' },
    body: '{}',
  })
  assert.equal(unsupportedCharset.status, 500)
  assert.deepEqual(await unsupportedCharset.json(), {
    code: 50000,
    message: '服务暂不可用，请稍后重试',
    data: null,
  })
})

test('a zip file inside multipart still reaches normal submission validation without scheduling evaluation', async () => {
  const form = new FormData()
  form.set('questionId', 'missing-question-fixture')
  form.set('questionVersion', '1')
  form.set('code', 'print(1)')
  form.set('idempotencyKey', 'uncompressed-multipart-fixture')
  form.set(
    'file',
    new Blob([Uint8Array.from([80, 75, 5, 6, ...new Array(18).fill(0)])], { type: 'application/zip' }),
    'fixture.zip',
  )
  const response = await fetch(base + '/submissions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  assert.equal(response.status, 404)
  assert.match(((await response.json()) as any).message, /题目/)
  assert.equal(await prisma.submission.count(), 0)
  assert.equal(await prisma.evaluationTask.count(), 0)
})
