import crypto from 'node:crypto'
import { RequestError } from './prdContract.js'

export class AuthError extends RequestError {
  constructor(message: string, status: number, public code: number, public retryAfterSeconds?: number) {
    super(message, status)
  }
}

export function validateNewPassword(password: string): void {
  const length = Array.from(password).length
  if (length < 15 || length > 128) throw new RequestError('新密码需要 15～128 个字符')
}

// Keep the existing scrypt format/cost so previous deployments can verify new hashes.
let active = 0
const waiting: Array<() => void> = []
async function derive(password: string, salt: string): Promise<Buffer> {
  if (active >= 4) {
    if (waiting.length >= 16) throw new AuthError('身份服务繁忙，请稍后重试', 503, 50300)
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        const index = waiting.indexOf(ready)
        if (index !== -1) waiting.splice(index, 1)
        reject(new AuthError('身份服务繁忙，请稍后重试', 503, 50300))
      }, 1000)
      waiting.push(ready)
    })
  } else active++
  try {
    return await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, (error, value) => error ? reject(error) : resolve(value)))
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${(await derive(password, salt)).toString('hex')}`
}

const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`
export async function verifyPasswordAsync(password: string, stored = DUMMY_HASH): Promise<boolean> {
  const [salt, hash, extra] = stored.split(':')
  if (!salt || !/^[a-f0-9]{128}$/i.test(hash ?? '') || extra) return false
  const actual = await derive(password, salt)
  const expected = Buffer.from(hash!, 'hex')
  return crypto.timingSafeEqual(actual, expected)
}
