import nodemailer from 'nodemailer'
import { AuthError } from '../lib/authPassword.js'

export type EmailPurpose = 'registration' | 'bind' | 'reset'
export type VerificationEmail = { to: string; purpose: EmailPurpose; url: string }
export type EmailSender = (message: VerificationEmail) => Promise<void>

export function emailEnabled(): boolean {
  return process.env.AUTH_EMAIL_ENABLED === 'true'
}
export function assertEmailEnabled(): void {
  if (!emailEnabled())
    throw new AuthError('邮箱验证功能尚未开放，请使用现有注册或联系管理员恢复密码', 503, 50310)
}
export function normalizeEmail(input: unknown): string {
  if (typeof input !== 'string') throw new AuthError('请填写有效邮箱地址', 400, 40016)
  const email = input.trim().toLowerCase()
  // Accept one unquoted ASCII mailbox, never an address list, header or display-name string.
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      email,
    ) ||
    email.split('@')[0]!.length > 64 ||
    email.startsWith('.') ||
    email.includes('..') ||
    email.includes('.@')
  )
    throw new AuthError('请填写有效邮箱地址', 400, 40016)
  return email
}
export function verificationUrl(token: string, purpose: EmailPurpose): string {
  let origin: URL
  try {
    origin = new URL(process.env.AUTH_EMAIL_SITE_ORIGIN ?? '')
  } catch {
    throw new AuthError('邮箱服务尚未完成配置', 503, 50310)
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new AuthError('邮箱服务尚未完成配置', 503, 50310)
  const url = new URL('/email-verification', origin)
  url.hash = new URLSearchParams({ token, purpose }).toString()
  return url.toString()
}

export function smtpSettings() {
  if (process.env.AUTH_EMAIL_SEND_ENABLED !== 'true')
    throw new AuthError('邮箱投递尚未开放，请联系管理员', 503, 50310)
  const host = process.env.SMTP_HOST?.trim()
  const port = Number(process.env.SMTP_PORT ?? '465')
  const user = process.env.SMTP_USER,
    pass = process.env.SMTP_PASSWORD
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass)
    throw new AuthError('邮箱服务尚未完成配置', 503, 50310)
  let from: string
  try {
    from = normalizeEmail(process.env.SMTP_FROM)
  } catch {
    throw new AuthError('邮箱服务尚未完成配置', 503, 50310)
  }
  return { host, port, user, pass, from }
}
export const sendVerificationEmail: EmailSender = async (message) => {
  assertEmailEnabled()
  const { host, port, user, pass, from } = smtpSettings()
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: { user, pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  })
  const action = { registration: '注册邮箱验证', bind: '绑定邮箱', reset: '恢复密码' }[message.purpose]
  try {
    await transport.sendMail({
      from,
      to: normalizeEmail(message.to),
      subject: `AI安全教学实验系统：${action}`,
      text: `您申请了${action}。请在15分钟内打开以下链接并在页面确认：\n\n${message.url}\n\n链接只能使用一次。如非本人操作，请忽略此邮件。`,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  } finally {
    transport.close()
  }
}
