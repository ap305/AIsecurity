import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let auth: typeof import('../src/lib/auth.js')
let server: http.Server, base: string, adminToken: string
const password = 'original passphrase 123'
async function request(route: string, method = 'GET', body?: unknown, token = '', headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  let json: any
  try { json = JSON.parse(raw) } catch { json = { raw } }
  return { status: response.status, json }
}
async function create(username: string, secret = password, role = 'student') {
  return prisma.user.create({ data: { username, displayName: username, password: auth.hashPassword(secret), role } })
}
async function login(username: string, secret = password, role = 'student') {
  const result = await request('/auth/login', 'POST', { username, password: secret, role })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  return result.json.data.token as string
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  auth = await import('../src/lib/auth.js')
  await create('securityadmin', password, 'admin')
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  adminToken = await login('securityadmin', password, 'admin')
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
})

test('logout revokes the copied credential at all shared auth entry points, not other sessions', async () => {
  const user = await create('logoutstudent')
  const token = await login(user.username), other = await login(user.username)
  const result = await request('/auth/logout', 'POST', {}, token)
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.data, { ok: true })
  for (const [route, method] of [['/auth/me', 'GET'], ['/auth/me', 'PUT'], ['/questions/missing/submissions', 'GET']]) {
    const rejected = await request(route!, method!, method === 'PUT' ? {} : undefined, token)
    assert.equal(rejected.status, 401)
    assert.equal(rejected.json.code, 40100)
  }
  assert.equal(await auth.userByPayload(auth.verifyToken(token)), null)
  assert.equal((await request('/auth/me', 'GET', undefined, other)).status, 200)
  assert.equal((await request('/auth/logout', 'POST', {}, token)).status, 200, 'idempotent logout')
  const revoked = await (prisma as any).authRevocation.findMany({ where: { userId: user.id } })
  assert.equal(revoked.length, 1)
  assert.match(revoked[0].tokenHash, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(revoked), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('admin logout is enforced by requireAdminUser and middleware; ordinary forbidden remains 403', async () => {
  const token = await login('securityadmin', password, 'admin')
  assert.equal((await request('/auth/logout', 'POST', {}, token)).status, 200)
  for (const route of ['/admin/users', '/admin/api-pool']) {
    const result = await request(route, 'GET', undefined, token)
    assert.equal(result.status, 401)
    assert.equal(result.json.code, 40100)
  }
  await create('forbiddenstudent')
  const result = await request('/admin/users', 'GET', undefined, await login('forbiddenstudent'))
  assert.equal(result.status, 403)
  assert.equal(result.json.code, 40300)
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'securityadmin' } })
  const oldStudentRole = auth.signScopedToken({ uid: admin.id, u: admin.username, r: 'student', exp: Date.now() + 60000 })
  assert.equal((await request('/admin/users', 'GET', undefined, oldStudentRole)).status, 403, 'current database admin role cannot promote an old student-role credential')
})

test('self change-password revokes only the target account, rotates current token and invalidates leases', async () => {
  const user = await create('changestudent')
  await create('unaffectedstudent')
  const token = await login(user.username), unaffected = await login('unaffectedstudent')
  await prisma.teacherLease.create({ data: { userId: user.id, questionId: 'fixture', questionVersion: 1, poolSnapshot: '{}', state: 'active', nonce: 'old', maxCalls: 10 } })
  const changed = await request('/auth/change-password', 'POST', { currentPassword: password, newPassword: 'new passphrase 456' }, token)
  assert.equal(changed.status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, changed.json.data.token)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, unaffected)).status, 200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, 1)
  assert.equal((await prisma.teacherLease.findFirstOrThrow({ where: { userId: user.id } })).state, 'revoked')
  assert.equal((await request('/auth/login', 'POST', { username: user.username, password, role: 'student' })).status, 400)
  await login(user.username, 'new passphrase 456')
})

test('logout-others replaces the current token and monotonically invalidates older credentials', async () => {
  const user = await create('othersstudent')
  const token = await login(user.username)
  const changed = await request('/auth/logout-others', 'POST', {}, token)
  assert.equal(changed.status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, changed.json.data.token)).status, 200)
  assert.equal((await request('/auth/logout-others', 'POST', {}, token)).status, 401)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, 1)
})

test('concurrent password changes cannot overwrite the winner or revive old sessions', async () => {
  const user = await create('racingstudent'), token = await login(user.username)
  const results = await Promise.all(['winner passphrase A', 'winner passphrase B'].map((newPassword) =>
    request('/auth/change-password', 'POST', { currentPassword: password, newPassword }, token)))
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.ok(results.some((result) => result.status === 401 || result.status === 409))
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(row.sessionVersion, 1)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, results.find((r) => r.status === 200)!.json.data.token)).status, 200)
})

test('concurrent change-password and logout-others use the same monotonic session guard', async () => {
  const user = await create('simultaneousstudent'), token = await login(user.username)
  const results = await Promise.all([
    request('/auth/change-password', 'POST', { currentPassword: password, newPassword: 'guarded change passphrase' }, token),
    request('/auth/logout-others', 'POST', {}, token),
  ])
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, 1)
  assert.equal((await request('/auth/me', 'GET', undefined, results.find((result) => result.status === 200)!.json.data.token)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
})

test('admin explicit reset validates new passphrases, bumps only target version and records redacted audit', async () => {
  const user = await create('resetstudent'), token = await login(user.username)
  assert.equal((await request(`/admin/users/${user.id}/password`, 'PUT', { password: 'short' }, adminToken)).status, 400)
  assert.equal((await request(`/admin/users/${user.id}/password`, 'PUT', { password: 'reset passphrase 789' }, adminToken)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, adminToken)).status, 200)
  const events = await request(`/admin/auth-events?userId=${user.id}&limit=1000`, 'GET', undefined, adminToken)
  assert.equal(events.status, 200)
  assert.ok(Array.isArray(events.json.data) && events.json.data.length <= 100)
  assert.ok(events.json.data.some((event: any) => event.action === 'auth.password.reset'))
  assert.doesNotMatch(JSON.stringify(events.json.data), /reset passphrase|original passphrase|Bearer|currentPassword/)
  await login(user.username, 'reset passphrase 789')
})

test('old long and whitespace passwords, exact-case usernames and sv-missing legacy tokens stay valid', async () => {
  const long = `  ${'密🔒'.repeat(200)}  `
  const user = await create('LegacyCase', long)
  const token = await login(user.username, long)
  const legacy = auth.signScopedToken({ uid: user.id, u: user.username, r: 'student', exp: Date.now() + 60000 })
  assert.equal((await request('/auth/me', 'GET', undefined, legacy)).status, 200)
  assert.equal((await request('/auth/logout', 'POST', {}, legacy)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, legacy)).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 200)
  assert.equal((await request('/auth/login', 'POST', { username: 'legacycase', password: long, role: 'student' })).status, 400)
  assert.equal((await request('/auth/login', 'POST', { username: user.username, password: long.trim(), role: 'student' })).status, 400)
})

test('new passwords count Unicode characters, retain spaces and reject outside 15–128', async () => {
  for (const secret of ['x'.repeat(14), '🔒'.repeat(129)])
    assert.equal((await request('/auth/register', 'POST', { username: 'invalidnew', password: secret, displayName: 'fixture' })).status, 400)
  assert.equal((await request('/auth/register', 'POST', { username: 'unicodenew', password: '🔒'.repeat(15), displayName: 'fixture' })).status, 200)
  await login('unicodenew', '🔒'.repeat(15))
})

test('account cooldown persists in storage without blocking other accounts behind shared or forged IPs', async () => {
  await create('cooldownstudent')
  for (let index = 0; index < 5; index++)
    await request('/auth/login', 'POST', { username: 'cooldownstudent', password: 'wrong', role: 'student' }, '', { 'X-Forwarded-For': `203.0.113.${index + 1}` })
  const blocked = await request('/auth/login', 'POST', { username: 'cooldownstudent', password, role: 'student' }, '', { 'X-Forwarded-For': '203.0.113.200' })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json.code, 42900)
  assert.ok(blocked.json.data.retryAfterSeconds > 0)
  assert.ok(await (prisma as any).authLoginThrottle.count() > 0)
  await create('samenatstudent')
  await login('samenatstudent')
  await (prisma as any).authLoginThrottle.updateMany({ data: { blockedUntil: new Date(Date.now() - 1000) } })
  await login('cooldownstudent')
})

test('revocation storage failure fails closed as retryable 503 and logout never reports false success', async () => {
  await create('outagestudent')
  const token = await login('outagestudent')
  assert.ok((prisma as any).authRevocation, 'revocation storage must exist')
  const original = (prisma as any).authRevocation.findUnique
  ;(prisma as any).authRevocation.findUnique = async () => { throw new Error('isolated auth store outage') }
  try {
    for (const [route, credential] of [['/auth/me', token], ['/questions/missing/submissions', token], ['/admin/users', adminToken], ['/admin/api-pool', adminToken]]) {
      const result = await request(route!, 'GET', undefined, credential)
      assert.equal(result.status, 503)
      assert.equal(result.json.code, 50300)
    }
  } finally { (prisma as any).authRevocation.findUnique = original }
  const originalTransaction = prisma.$transaction
  prisma.$transaction = (async () => { throw new Error('isolated transaction outage') }) as any
  try {
    const result = await request('/auth/logout', 'POST', {}, token)
    assert.equal(result.status, 503)
    assert.equal(result.json.code, 50300)
  } finally { prisma.$transaction = originalTransaction }
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 200)
})

test('in-flight evaluation, teacher and selftest capabilities retain purpose isolation after web logout', async () => {
  await create('scopedstudent')
  const token = await login('scopedstudent')
  const scoped = ['evaluation', 'teacher', 'selftest'].map((purpose) => auth.signScopedToken({ purpose, exp: Date.now() + 60000, taskId: 'frozen-task' }))
  assert.equal((await request('/auth/logout', 'POST', {}, token)).status, 200)
  for (const [index, purpose] of ['evaluation', 'teacher', 'selftest'].entries()) {
    assert.equal(auth.verifyToken(scoped[index]), null)
    assert.equal(auth.readScopedToken(scoped[index]!, purpose)?.taskId, 'frozen-task')
    assert.equal(auth.readScopedToken(scoped[index]!, 'other-purpose'), null)
  }
})

test('manual recovery config and last login expose public metadata only', async () => {
  assert.deepEqual((await request('/auth/config')).json.data, { manualResetEnabled: true, emailEnabled: false })
  const result = await request('/auth/me', 'GET', undefined, adminToken)
  assert.equal(result.status, 200)
  assert.ok(Number.isFinite(Date.parse(result.json.data.user.lastLoginAt)))
  assert.equal(result.json.data.user.mustChangePassword, false)
})

test('manual initial-password reset requires verified identity and limits every business entry until first change', async () => {
  const user = await create('manualstudent'), oldToken = await login(user.username)
  assert.equal((await request(`/admin/users/${user.id}/password-reset`, 'POST', {}, adminToken)).status, 400)
  const reset = await request(`/admin/users/${user.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)
  assert.equal(reset.status, 200)
  assert.equal(reset.json.data.ok, true)
  assert.ok(reset.json.data.temporaryPassword.length > 0)
  assert.ok(Date.parse(reset.json.data.expiresAt) <= Date.now() + 15 * 60 * 1000)
  assert.equal((await request('/auth/me', 'GET', undefined, oldToken)).status, 401)
  const token = await login(user.username, reset.json.data.temporaryPassword)
  const me = await request('/auth/me', 'GET', undefined, token)
  assert.equal(me.status, 200)
  assert.equal(me.json.data.user.mustChangePassword, true)
  for (const [route, method] of [['/auth/me', 'PUT'], ['/auth/logout-others', 'POST'], ['/questions/missing/submissions', 'GET'], ['/admin/users', 'GET']]) {
    const result = await request(route!, method!, method === 'GET' ? undefined : {}, token)
    assert.equal(result.status, 428)
    assert.equal(result.json.code, 42801)
  }
  await assert.rejects(() => auth.userByPayload(auth.verifyToken(token)), (error: any) => error.code === 42801)
  assert.equal((await request('/auth/change-password', 'POST', { currentPassword: reset.json.data.temporaryPassword, newPassword: reset.json.data.temporaryPassword }, token)).status, 400)
  const changed = await request('/auth/change-password', 'POST', { currentPassword: reset.json.data.temporaryPassword, newPassword: 'new manual passphrase' }, token)
  assert.equal(changed.status, 200)
  assert.equal(changed.json.data.user.mustChangePassword, false)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'PUT', { displayName: 'updated' }, changed.json.data.token)).status, 200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, 2)
})

test('limited web credentials cannot use any public business route while anonymous and ordinary callers retain access', async () => {
  const user = await create('publiclimitedstudent')
  const reset = await request(`/admin/users/${user.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)
  const token = await login(user.username, reset.json.data.temporaryPassword)
  await create('publicnormalstudent')
  const ordinary = await login('publicnormalstudent')
  const routes = ['/modules/M1/questions', '/questions/reviewmissing/resources', '/leaderboard', `/users/${user.id}/stats`]
  for (const route of routes) {
    const result = await request(route, 'GET', undefined, token)
    assert.equal(result.status, 428, route)
    assert.equal(result.json.code, 42801, route)
    assert.equal((await request(route)).status, 200, `anonymous ${route}`)
    assert.equal((await request(route, 'GET', undefined, ordinary)).status, 200, `ordinary ${route}`)
  }
  assert.equal((await request('/auth/login', 'POST', { username: user.username, password: reset.json.data.temporaryPassword, role: 'student' }, token)).json.code, 42801)
  assert.equal((await request('/auth/config', 'GET', undefined, token)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 200)
  const payload = auth.verifyToken(token)!
  const legacyLimited = auth.signScopedToken({ uid: user.id, u: user.username, r: 'student', sv: payload.sv, exp: payload.exp })
  assert.equal((await request('/leaderboard', 'GET', undefined, legacyLimited)).json.code, 42801, 'old limited token without a marker is checked against persisted state')
})

test('limited public-route gating verifies signature, database expiry, revocation and session version', async () => {
  const user = await create('publicinvalidstudent')
  const reset = await request(`/admin/users/${user.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)
  const token = await login(user.username, reset.json.data.temporaryPassword)
  const [body, signature] = token.split('.')
  const tamperedBody = { ...JSON.parse(Buffer.from(body!, 'base64url').toString()), limited: false }
  const tampered = `${Buffer.from(JSON.stringify(tamperedBody)).toString('base64url')}.${signature}`
  assert.equal(auth.verifyToken(tampered), null)
  assert.equal((await request('/questions', 'GET', undefined, tampered)).status, 401, 'tampering never grants authenticated access')
  assert.equal((await request('/leaderboard', 'GET', undefined, tampered)).status, 200, 'invalid signature has only the existing anonymous public access')
  await prisma.userSecurity.update({ where: { userId: user.id }, data: { temporaryPasswordExpiresAt: new Date(Date.now() - 1000) } })
  let result = await request('/leaderboard', 'GET', undefined, token)
  assert.equal(result.status, 401)
  assert.equal(result.json.code, 40100)
  await prisma.userSecurity.update({ where: { userId: user.id }, data: { temporaryPasswordExpiresAt: new Date(Date.now() + 60000) } })
  assert.equal((await request('/auth/logout', 'POST', {}, token)).status, 200)
  result = await request('/leaderboard', 'GET', undefined, token)
  assert.equal(result.status, 401)
  assert.equal(result.json.code, 40100)
  const fresh = await login(user.username, reset.json.data.temporaryPassword)
  await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } })
  assert.equal((await request('/leaderboard', 'GET', undefined, fresh)).json.code, 40100)
})

test('public-route limited-session middleware does not intercept independent purpose capabilities', async () => {
  const original = prisma.userSecurity.findUnique
  prisma.userSecurity.findUnique = (async () => { throw new Error('web security store must not be consulted for scoped capabilities') }) as any
  try {
    for (const purpose of ['teacher', 'evaluation', 'selftest']) {
      const token = auth.signScopedToken({ purpose, uid: 'scoped-fixture', u: 'scoped', r: 'student', limited: true, exp: Date.now() + 60000 })
      assert.equal((await request('/leaderboard', 'GET', undefined, token)).status, 200)
      assert.equal(auth.readScopedToken(token, purpose)?.purpose, purpose)
    }
    assert.equal((await request('/leaderboard')).status, 200, 'anonymous public access needs no identity store')
  } finally { prisma.userSecurity.findUnique = original }
})

test('expired temporary credentials fail closed and explicit administrator password setting also requires first change', async () => {
  const user = await create('expiredstudent')
  const reset = await request(`/admin/users/${user.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)
  assert.equal(reset.status, 200)
  const token = await login(user.username, reset.json.data.temporaryPassword)
  await (prisma as any).userSecurity.update({ where: { userId: user.id }, data: { temporaryPasswordExpiresAt: new Date(Date.now() - 1000) } })
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/login', 'POST', { username: user.username, password: reset.json.data.temporaryPassword, role: 'student' })).status, 401)
  assert.equal((await request(`/admin/users/${user.id}/password`, 'PUT', { password: 'explicit reset phrase' }, adminToken)).status, 200)
  const explicit = await login(user.username, 'explicit reset phrase')
  assert.equal((await request('/questions/missing/submissions', 'GET', undefined, explicit)).json.code, 42801)
})

test('manual reset never reactivates a disabled account or enables administrator recovery', async () => {
  const user = await create('disabledresetstudent')
  await prisma.user.update({ where: { id: user.id }, data: { accountStatus: 'disabled' } })
  const reset = await request(`/admin/users/${user.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)
  assert.equal(reset.status, 200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).accountStatus, 'disabled')
  assert.equal((await request('/auth/login', 'POST', { username: user.username, password: reset.json.data.temporaryPassword, role: 'student' })).status, 403)
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'securityadmin' } })
  assert.equal((await request(`/admin/users/${admin.id}/password-reset`, 'POST', { identityVerified: true }, adminToken)).status, 403)
})

test('bounded asynchronous scrypt keeps timers responsive and returns retryable overload instead of an unbounded queue', async () => {
  const { hashPasswordAsync, verifyPasswordAsync } = await import('../src/lib/authPassword.js')
  let ticked = false
  const timer = setTimeout(() => { ticked = true }, 5)
  const results = await Promise.allSettled(Array.from({ length: 48 }, () => hashPasswordAsync('isolated load passphrase')))
  clearTimeout(timer)
  assert.equal(ticked, true)
  const accepted = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.ok(accepted.length > 0 && rejected.length > 0)
  assert.ok(rejected.every((result) => result.status === 'rejected' && result.reason.code === 50300))
  const stored = (accepted[0] as PromiseFulfilledResult<string>).value
  assert.equal(await verifyPasswordAsync('isolated load passphrase', stored), true)
  assert.equal(auth.verifyPassword('isolated load passphrase', stored), true, 'old verifier can still read the new hash')
})

test('two logins in the same millisecond get independent credentials', async () => {
  await create('sameinstantstudent')
  const now = Date.now(), original = Date.now
  Date.now = () => now
  let first: string, second: string
  try {
    first = await login('sameinstantstudent')
    second = await login('sameinstantstudent')
  } finally { Date.now = original }
  assert.notEqual(first, second)
  assert.equal((await request('/auth/logout', 'POST', {}, first)).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, second)).status, 200)
})
