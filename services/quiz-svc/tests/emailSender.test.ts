import test from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { normalizeEmail, sendVerificationEmail, verificationUrl } from '../src/services/emailSender.js'

test('SMTP boundary uses verified TLS, bounded timeouts and no remote/file content or protocol logs', async (t) => {
  const values = {
    AUTH_EMAIL_ENABLED: 'true',
    AUTH_EMAIL_SEND_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'placeholder-user',
    SMTP_PASSWORD: 'placeholder-password',
    SMTP_FROM: 'sender@example.test',
  }
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      value === undefined ? delete process.env[key] : (process.env[key] = value)
  })
  let config: any,
    mail: any,
    closed = false
  t.mock.method(nodemailer, 'createTransport', (options: unknown) => {
    config = options
    return {
      sendMail: async (message: unknown) => {
        mail = message
      },
      close: () => {
        closed = true
      },
    }
  })
  await sendVerificationEmail({
    to: 'student@example.test',
    purpose: 'reset',
    url: 'https://teaching.example.test/email-verification#token=local-test-only',
  })
  assert.equal(config.secure, false)
  assert.equal(config.requireTLS, true)
  assert.equal(config.tls.rejectUnauthorized, true)
  assert.equal(config.tls.minVersion, 'TLSv1.2')
  assert.equal(config.disableFileAccess, true)
  assert.equal(config.disableUrlAccess, true)
  assert.equal(config.logger, false)
  assert.equal(config.debug, false)
  assert.ok(config.connectionTimeout > 0 && config.socketTimeout <= 10000)
  assert.equal(mail.from, 'sender@example.test')
  assert.equal(mail.to, 'student@example.test')
  assert.equal(mail.disableFileAccess, true)
  assert.equal(mail.disableUrlAccess, true)
  assert.equal(closed, true)
  process.env.SMTP_PORT = '465'
  await sendVerificationEmail({
    to: 'student@example.test',
    purpose: 'registration',
    url: 'https://teaching.example.test/#local-only',
  })
  assert.equal(config.secure, true)
})

test('email and fixed origin reject injected headers, address lists and off-origin link settings', (t) => {
  assert.equal(normalizeEmail(' Student@EXAMPLE.test '), 'student@example.test')
  for (const invalid of [
    'student@example.test\r\nBcc: victim@example.test',
    'one@example.test,two@example.test',
    'Name <one@example.test>',
    '.bad@example.test',
    'a..b@example.test',
  ])
    assert.throws(() => normalizeEmail(invalid))
  const previous = process.env.AUTH_EMAIL_SITE_ORIGIN
  t.after(() => {
    previous === undefined
      ? delete process.env.AUTH_EMAIL_SITE_ORIGIN
      : (process.env.AUTH_EMAIL_SITE_ORIGIN = previous)
  })
  for (const origin of [
    'http://example.test',
    'https://user:secret@example.test',
    'https://example.test/path',
    'https://example.test?query=1',
    'https://example.test#fragment',
  ]) {
    process.env.AUTH_EMAIL_SITE_ORIGIN = origin
    assert.throws(() => verificationUrl('local-test-only', 'bind'))
  }
})
