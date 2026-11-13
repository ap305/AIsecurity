import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let auth: typeof import('../src/lib/auth.js')
let server: http.Server, base: string
const password = 'original email passphrase 123'
const messages: Array<{ to: string; url: string; purpose: string }> = []
let sendingFails = false
let sendBarrier: Promise<void> | undefined
async function request(route: string, body?: unknown, token = '') {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  let json: any
  try {
    json = JSON.parse(raw)
  } catch {
    json = { raw }
  }
  return { status: response.status, json }
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  auth = await import('../src/lib/auth.js')
  const app = express().use(express.json())
  app.use('/api', (await import('../src/routes/auth.js')).default)
  const { createAuthEmailRouter } = await import('../src/routes/authEmail.js')
  app.use(
    '/api',
    createAuthEmailRouter({
      sender: async (message) => {
        if (sendBarrier) await sendBarrier
        if (sendingFails) throw new Error('SMTP password=never-expose-me')
        messages.push(message)
      },
    }),
  )
  process.env.AUTH_EMAIL_SITE_ORIGIN = 'https://teaching.example.test'
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  delete process.env.AUTH_EMAIL_ENABLED
  delete process.env.AUTH_EMAIL_SITE_ORIGIN
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
})

test('email disabled advertises disabled and preserves legacy registration', async () => {
  delete process.env.AUTH_EMAIL_ENABLED
  assert.equal((await request('/auth/config')).json.data.emailEnabled, false)
  const result = await request('/auth/register', {
    username: 'emailoffstudent',
    displayName: 'Old flow',
    password,
  })
  assert.equal(result.status, 200)
  assert.equal(
    (await request('/auth/email/request', { purpose: 'registration', email: 'off@example.test' })).status,
    503,
  )
  assert.equal(messages.length, 0)
})

test('email enabled cannot create a new account without verified email', async () => {
  process.env.AUTH_EMAIL_ENABLED = 'true'
  const result = await request('/auth/register', {
    username: 'requiresmail',
    displayName: 'New flow',
    password,
  })
  assert.equal(result.status, 400)
  assert.equal(await prisma.user.findUnique({ where: { username: 'requiresmail' } }), null)
})

async function challenge(email: string, purpose = 'registration', token = '') {
  const result = await request(
    '/auth/email/request',
    { email, purpose, ...(purpose === 'bind' ? { currentPassword: password } : {}) },
    token,
  )
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.deepEqual(result.json.data, { accepted: true })
  const message = messages.at(-1)!
  const url = new URL(message.url)
  assert.equal(url.origin, 'https://teaching.example.test')
  assert.equal(url.search, '')
  assert.equal(url.pathname, '/email-verification')
  const secret = new URLSearchParams(url.hash.slice(1)).get('token')!
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(result.json).includes(secret))
  return secret
}
async function create(username: string, role = 'student', accountStatus = 'active') {
  const row = await prisma.user.create({
    data: { username, displayName: username, password: auth.hashPassword(password), role, accountStatus },
  })
  const result = accountStatus === 'active' ? await auth.loginUser(username, password, role) : null
  return { row, token: result?.token ?? '' }
}
test('verified registration consumes token once and commits verified mailbox with account', async () => {
  const token = await challenge('  Verified@EXAMPLE.test ')
  const row = await prisma.emailChallenge.findFirstOrThrow({ where: { email: 'verified@example.test' } })
  assert.equal(row.tokenHash.length, 64)
  assert.ok(!JSON.stringify(row).includes(token))
  const fields = { username: 'verifiedstudent', displayName: 'Verified', password, emailToken: token }
  const result = await request('/auth/register', fields)
  assert.equal(result.status, 200)
  assert.equal(
    (await prisma.userEmail.findUniqueOrThrow({ where: { userId: result.json.data.user.id } })).email,
    'verified@example.test',
  )
  assert.equal((await request('/auth/register', { ...fields, username: 'replayedstudent' })).status, 400)
  assert.equal(await prisma.user.findUnique({ where: { username: 'replayedstudent' } }), null)
})
test('registration race creates at most one account and invalid input does not burn token', async () => {
  const token = await challenge('race@example.test')
  assert.equal(
    (
      await request('/auth/register', {
        username: 'bad',
        displayName: 'Bad',
        password: 'short',
        emailToken: token,
      })
    ).status,
    400,
  )
  const results = await Promise.all(
    ['mailracea', 'mailraceb'].map((username) =>
      request('/auth/register', { username, displayName: username, password, emailToken: token }),
    ),
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1)
  assert.equal(await prisma.user.count({ where: { username: { in: ['mailracea', 'mailraceb'] } } }), 1)
})
test('bind requires valid session and password and atomically rotates mailbox and sessions', async () => {
  const { row, token } = await create('bindstudent')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'oldbind@example.test', verifiedAt: new Date() },
  })
  assert.equal(
    (
      await request(
        '/auth/email/request',
        { email: 'newbind@example.test', purpose: 'bind', currentPassword: 'wrong' },
        token,
      )
    ).status,
    400,
  )
  const secret = await challenge('newbind@example.test', 'bind', token)
  assert.equal(
    (await prisma.userEmail.findUniqueOrThrow({ where: { userId: row.id } })).email,
    'oldbind@example.test',
  )
  const wrong = await request('/auth/email/bind', { token: secret, currentPassword: 'wrong' }, token)
  assert.equal(wrong.status, 400)
  assert.notEqual(wrong.json.code, 40100)
  assert.equal(
    (await request('/auth/email/bind', { token: secret, currentPassword: password }, token)).status,
    200,
  )
  assert.equal(
    (await prisma.userEmail.findUniqueOrThrow({ where: { userId: row.id } })).email,
    'newbind@example.test',
  )
  assert.equal(await auth.userByPayload(auth.verifyToken(token)), null)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: row.id } })).sessionVersion, 1)
})
test('reset consumes once, clears temporary state, revokes leases and all old sessions', async () => {
  const { row, token } = await create('recoverstudent')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'recover@example.test', verifiedAt: new Date() },
  })
  await prisma.userSecurity.update({
    where: { userId: row.id },
    data: { mustChangePassword: true, temporaryPasswordExpiresAt: new Date() },
  })
  await prisma.teacherLease.create({
    data: {
      userId: row.id,
      questionId: 'fixture',
      questionVersion: 1,
      poolSnapshot: '{}',
      state: 'active',
      nonce: 'old',
      maxCalls: 10,
    },
  })
  const secret = await challenge('recover@example.test', 'reset')
  const results = await Promise.all(
    ['recovered passphrase A', 'recovered passphrase B'].map((newPassword) =>
      request('/auth/password-recovery', { token: secret, newPassword }),
    ),
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1)
  assert.ok(results.every((r) => r.status === 200 || (r.status === 400 && r.json.code !== 40100)))
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: row.id } })
  assert.equal(fresh.sessionVersion, 1)
  assert.equal(await auth.userByPayload(auth.verifyToken(token)), null)
  const security = await prisma.userSecurity.findUniqueOrThrow({ where: { userId: row.id } })
  assert.equal(security.mustChangePassword, false)
  assert.equal(security.temporaryPasswordExpiresAt, null)
  assert.equal((await prisma.teacherLease.findFirstOrThrow({ where: { userId: row.id } })).state, 'revoked')
  assert.ok(
    auth.verifyPassword(
      results[0].status === 200 ? 'recovered passphrase A' : 'recovered passphrase B',
      fresh.password,
    ),
  )
})
test('expired, wrong-purpose and superseded-session challenges cannot change credentials', async () => {
  const registration = await challenge('wrongpurpose@example.test')
  assert.equal(
    (await request('/auth/password-recovery', { token: registration, newPassword: password })).status,
    400,
  )
  await prisma.emailChallenge.updateMany({
    where: { email: 'wrongpurpose@example.test' },
    data: { expiresAt: new Date(0) },
  })
  assert.equal(
    (
      await request('/auth/register', {
        username: 'expiredmail',
        displayName: 'Expired',
        password,
        emailToken: registration,
      })
    ).status,
    400,
  )
  const { row } = await create('changedmail')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'changed@example.test', verifiedAt: new Date() },
  })
  const reset = await challenge('changed@example.test', 'reset')
  await prisma.user.update({ where: { id: row.id }, data: { sessionVersion: { increment: 1 } } })
  assert.equal(
    (await request('/auth/password-recovery', { token: reset, newPassword: 'new recovered secret 123' }))
      .status,
    400,
  )
})
test('unavailable reset targets share acceptance and never mail or reactivate', async () => {
  for (const [name, role, status] of [
    ['disabledmail', 'student', 'disabled'],
    ['deletedmail', 'student', 'deleted'],
    ['adminmail', 'admin', 'active'],
  ]) {
    const { row } = await create(name!, role!, status!)
    await prisma.userEmail.create({
      data: { userId: row.id, email: `${name}@example.test`, verifiedAt: new Date() },
    })
  }
  const count = messages.length
  for (const email of [
    'missing@example.test',
    'disabledmail@example.test',
    'deletedmail@example.test',
    'adminmail@example.test',
  ]) {
    const result = await request('/auth/email/request', { purpose: 'reset', email })
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.data, { accepted: true })
  }
  assert.equal(messages.length, count)
})
test('cooldown and persistent hourly quotas stop repeated sends without trusting forwarded identity', async () => {
  await challenge('limited@example.test')
  const cooldown = await request('/auth/email/request', {
    purpose: 'registration',
    email: 'LIMITED@example.test',
  })
  assert.equal(cooldown.status, 429)
  await prisma.emailSendThrottle.updateMany({
    where: { key: { not: 'global' } },
    data: { count: 5, lastSentAt: new Date(Date.now() - 61000) },
  })
  assert.equal(
    (await request('/auth/email/request', { purpose: 'registration', email: 'limited@example.test' })).status,
    429,
  )
  await prisma.emailSendThrottle.update({ where: { key: 'global' }, data: { count: 200 } })
  assert.equal(
    (await request('/auth/email/request', { purpose: 'registration', email: 'otherlimited@example.test' }))
      .status,
    429,
  )
  await prisma.emailSendThrottle.deleteMany()
})
test('failed sender keeps generic acceptance, invalidates its challenge and does not break legacy login', async () => {
  sendingFails = true
  const result = await request('/auth/email/request', {
    purpose: 'registration',
    email: 'failure@example.test',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.data, { accepted: true })
  assert.ok(!JSON.stringify(result.json).includes('never-expose-me'))
  for (
    let i = 0;
    i < 100 &&
    (await prisma.emailChallenge.count({ where: { email: 'failure@example.test', consumedAt: null } }));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  sendingFails = false
  assert.equal(
    await prisma.emailChallenge.count({ where: { email: 'failure@example.test', consumedAt: null } }),
    0,
  )
  const legacy = await create('legacynobinding')
  assert.ok(await auth.userByPayload(auth.verifyToken(legacy.token)))
})

test('known and unknown recovery return identical acceptance before SMTP completes', async () => {
  const { row } = await create('slowmail')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'slowmail@example.test', verifiedAt: new Date() },
  })
  let release!: () => void
  sendBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = request('/auth/email/request', { purpose: 'reset', email: 'slowmail@example.test' })
  try {
    const response = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ])
    assert.ok(response, 'SMTP completion must not gate HTTP acceptance')
    const absent = await request('/auth/email/request', {
      purpose: 'reset',
      email: 'slowabsent@example.test',
    })
    assert.deepEqual(response, absent)
  } finally {
    release()
    sendBarrier = undefined
    await pending
  }
})

test('a binding token is private to its account and unique email conflicts roll back consumption', async () => {
  const first = await create('boundowner'),
    second = await create('otherboundowner')
  const secret = await challenge('bindprivate@example.test', 'bind', first.token)
  const wrongAccount = await request(
    '/auth/email/bind',
    { token: secret, currentPassword: password },
    second.token,
  )
  assert.equal(wrongAccount.status, 400)
  assert.notEqual(wrongAccount.json.code, 40100)
  await prisma.userEmail.create({
    data: { userId: second.row.id, email: 'bindprivate@example.test', verifiedAt: new Date() },
  })
  assert.equal(
    (await request('/auth/email/bind', { token: secret, currentPassword: password }, first.token)).status,
    400,
  )
  assert.equal(
    (await prisma.emailChallenge.findFirstOrThrow({ where: { email: 'bindprivate@example.test' } }))
      .consumedAt,
    null,
  )
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: first.row.id } })).sessionVersion, 0)
  assert.equal(await prisma.userEmail.findUnique({ where: { userId: first.row.id } }), null)
})

test('a reset issued before disable, delete or promotion cannot change account state or privilege', async () => {
  for (const state of ['disabled', 'deleted', 'admin']) {
    const { row } = await create(`later${state}`)
    const email = `later${state}@example.test`
    await prisma.userEmail.create({ data: { userId: row.id, email, verifiedAt: new Date() } })
    const secret = await challenge(email, 'reset')
    await prisma.user.update({
      where: { id: row.id },
      data: state === 'admin' ? { role: 'admin' } : { accountStatus: state },
    })
    assert.equal(
      (await request('/auth/password-recovery', { token: secret, newPassword: 'must not apply secret 123' }))
        .status,
      400,
    )
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: row.id } })
    assert.equal(unchanged.password, row.password)
    assert.equal(unchanged.sessionVersion, 0)
    assert.equal(unchanged.accountStatus, state === 'admin' ? 'active' : state)
    assert.equal(unchanged.role, state === 'admin' ? 'admin' : 'student')
  }
})

test('requests never trust Host or X-Forwarded-For and a GET cannot consume verification', async () => {
  const result = await fetch(`${base}/auth/email/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': 'attacker-controlled',
      'X-Forwarded-Host': 'attacker.example',
    },
    body: JSON.stringify({ email: 'fixedhost@example.test', purpose: 'registration' }),
  })
  assert.equal(result.status, 200)
  const url = new URL(messages.at(-1)!.url)
  assert.equal(url.origin, 'https://teaching.example.test')
  assert.equal(
    (await request(`/auth/email/bind?token=${new URLSearchParams(url.hash.slice(1)).get('token')}`)).status,
    404,
  )
  assert.equal(
    (await prisma.emailChallenge.findFirstOrThrow({ where: { email: 'fixedhost@example.test' } })).consumedAt,
    null,
  )
  const again = await fetch(`${base}/auth/email/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'different-controlled' },
    body: JSON.stringify({ email: 'fixedhost@example.test', purpose: 'registration' }),
  })
  assert.equal(again.status, 429)
})

test('delivery disabled or misconfigured returns the same failure before checking known email', async () => {
  const { requestEmail } = await import('../src/services/authEmail.js')
  delete process.env.AUTH_EMAIL_SEND_ENABLED
  for (const email of ['recover@example.test', 'doesnotexist@example.test']) {
    await assert.rejects(
      requestEmail({ email, purpose: 'reset' }, null),
      (error: any) => error.status === 503 && error.code === 50310,
    )
  }
  assert.equal(await prisma.emailChallenge.count({ where: { email: 'doesnotexist@example.test' } }), 0)
})

test('real app temporary-password middleware permits anonymous recovery without a stale bearer', async () => {
  const { row } = await create('limitedemail')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'limitedrecovery@example.test', verifiedAt: new Date() },
  })
  await prisma.userSecurity.update({
    where: { userId: row.id },
    data: { mustChangePassword: true, temporaryPasswordExpiresAt: new Date(Date.now() + 60000) },
  })
  const limited = await auth.loginUser(row.username, password, 'student')
  const secret = await challenge('limitedrecovery@example.test', 'reset')
  const { app } = await import('../src/app.js')
  const actual = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => actual.once('listening', resolve))
  try {
    const url = `http://127.0.0.1:${(actual.address() as AddressInfo).port}/api/auth/password-recovery`
    const body = JSON.stringify({ token: secret, newPassword: 'recovered limited secret 123' })
    const blocked = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${limited.token}` },
      body,
    })
    assert.equal(blocked.status, 428)
    const recovered = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(recovered.status, 200)
    assert.equal(
      (await prisma.userSecurity.findUniqueOrThrow({ where: { userId: row.id } })).mustChangePassword,
      false,
    )
  } finally {
    await new Promise<void>((resolve) => actual.close(() => resolve()))
  }
})

test('queue saturation cannot reveal mailbox existence through the following request response', async () => {
  const { row } = await create('capacitytarget')
  await prisma.userEmail.create({
    data: { userId: row.id, email: 'capacitytarget@example.test', verifiedAt: new Date() },
  })
  let release!: () => void
  sendBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    for (let index = 0; index < 15; index++) {
      const accepted = await request('/auth/email/request', {
        purpose: 'registration',
        email: `queue${index}@example.test`,
      })
      assert.equal(accepted.status, 200)
    }
    const unknown = await request('/auth/email/request', {
      purpose: 'reset',
      email: 'capacityabsent@example.test',
    })
    const beforeFull = await request('/auth/email/request', {
      purpose: 'reset',
      email: 'probebefore@example.test',
    })
    const known = await request('/auth/email/request', {
      purpose: 'reset',
      email: 'capacitytarget@example.test',
    })
    const afterFull = await request('/auth/email/request', {
      purpose: 'reset',
      email: 'probeafter@example.test',
    })
    assert.deepEqual(known, unknown)
    assert.deepEqual(afterFull, beforeFull)
    assert.equal(afterFull.status, 200)
    assert.equal(
      (await request('/auth/email/request', { purpose: 'reset', email: 'probeafter@example.test' })).status,
      429,
      'overflow acceptance still consumes persistent throttle',
    )
    assert.equal(await prisma.emailChallenge.count({ where: { email: 'probeafter@example.test' } }), 0)
  } finally {
    release()
    sendBarrier = undefined
  }
})
