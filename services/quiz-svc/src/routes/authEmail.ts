import { Router, type Response } from 'express'
import { authPayload } from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { RequestError } from '../lib/prdContract.js'
import { bindEmail, ownEmail, recoverPassword, requestEmail } from '../services/authEmail.js'
import type { EmailSender } from '../services/emailSender.js'

function fail(res: Response, error: unknown) {
  const known = error instanceof RequestError
  const retry = error instanceof AuthError ? error.retryAfterSeconds : undefined
  if (retry) res.setHeader('Retry-After', retry)
  res.setHeader('Cache-Control', 'no-store')
  res
    .status(known ? error.status : 503)
    .json({
      code: error instanceof AuthError ? error.code : known ? 40016 : 50310,
      message: known ? error.message : '邮箱服务暂不可用，请稍后重试',
      data: retry ? { retryAfterSeconds: retry } : null,
    })
}
export function createAuthEmailRouter(options: { sender?: EmailSender } = {}) {
  if (options.sender && process.env.NODE_ENV !== 'test')
    throw new Error('Email sender injection is available only in local tests')
  const router = Router()
  router.use('/auth/email', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.get('/auth/email', async (req, res) => {
    try {
      res.json({ code: 0, message: 'ok', data: await ownEmail(authPayload(req)) })
    } catch (e) {
      fail(res, e)
    }
  })
  router.post('/auth/email/request', async (req, res) => {
    try {
      res.json({
        code: 0,
        message: '请求已受理，如符合条件系统将尝试发送验证邮件',
        data: await requestEmail(req.body ?? {}, authPayload(req), options.sender),
      })
    } catch (e) {
      fail(res, e)
    }
  })
  router.post('/auth/email/bind', async (req, res) => {
    try {
      res.json({
        code: 0,
        message: '邮箱已验证，请重新登录',
        data: await bindEmail(authPayload(req), req.body?.token, req.body?.currentPassword),
      })
    } catch (e) {
      fail(res, e)
    }
  })
  router.post('/auth/password-recovery', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json({
        code: 0,
        message: '密码已恢复，请重新登录',
        data: await recoverPassword(req.body?.token, req.body?.newPassword),
      })
    } catch (e) {
      fail(res, e)
    }
  })
  return router
}
export default createAuthEmailRouter()
