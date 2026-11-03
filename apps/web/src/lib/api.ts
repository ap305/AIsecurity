const API_BASE = '/api'
export const TOKEN_KEY = 'aisec_token'
export const AUTH_TIMEOUT_MS = 10000
// Deny-only fence: failed storage mutations must never fall back to a residual credential.
let credentialsBlocked = false

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function getAuthToken(): string | null {
  if (credentialsBlocked) return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setAuthToken(token: string | null): boolean {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    const stored = localStorage.getItem(TOKEN_KEY)
    if (stored !== token && !(token === null && !stored)) throw new Error('Credential storage mismatch')
    credentialsBlocked = false
    return true
  } catch {
    credentialsBlocked = true
    return false
  }
}

function authHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function handle<T>(res: Response): Promise<T> {
  let json: ApiResponse<T> | null = null
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    /* 非 JSON 响应（如网关错误页） */
  }
  const message = typeof json?.message === 'string' ? json.message : ''
  if (!res.ok)
    throw new ApiError(
      res.status,
      `API error: ${message || `${res.status} ${res.statusText}`}`,
      typeof json?.code === 'number' ? json.code : undefined,
    )
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.code !== 'number')
    throw new Error('服务返回的报文格式异常，请稍后重试。')
  if (json.code !== 0)
    throw new ApiError(res.status, `API error: ${message || '请求未成功，请重试。'}`, json.code)
  if (!Object.prototype.hasOwnProperty.call(json, 'data'))
    throw new Error('服务返回的报文格式异常，请稍后重试。')
  return json.data
}

const authFailureListeners = new Set<(error: ApiError, token: string) => void>()

export function subscribeAuthFailures(listener: (error: ApiError, token: string) => void): () => void {
  authFailureListeners.add(listener)
  return () => {
    authFailureListeners.delete(listener)
  }
}

export function reportAuthFailure(error: unknown, token: string | null): void {
  if (
    token &&
    token === getAuthToken() &&
    error instanceof ApiError &&
    ((error.code === 40100 && [200, 401].includes(error.status)) ||
      (error.code === 42801 && [200, 428].includes(error.status)))
  ) {
    authFailureListeners.forEach((listener) => listener(error, token))
  }
}

export function assertCurrentToken(token: string | null): void {
  if (token !== getAuthToken()) throw new Error('登录账号已变化，请在当前账号下重试。')
}

function authTimeout(path: string): number | undefined {
  return path.startsWith('/auth/') ||
    /^\/admin\/(?:auth-events|users(?:\/[^/]+\/(?:password|password-reset))?)(?:\?|$)/.test(path)
    ? AUTH_TIMEOUT_MS
    : undefined
}

async function request<T>(path: string, options: RequestInit, timeoutMs = authTimeout(path)): Promise<T> {
  const token = getAuthToken()
  const controller = timeoutMs == null ? null : new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = (async () => {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: authHeaders(
          token,
          options.body instanceof FormData
            ? undefined
            : options.body
              ? { 'Content-Type': 'application/json' }
              : undefined,
        ),
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      })
      return handle<T>(res)
    })()
    const data = controller
      ? await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('请求超时，请检查网络后重试。'))
            }, timeoutMs)
          }),
        ])
      : await operation
    assertCurrentToken(token)
    return data
  } catch (error) {
    assertCurrentToken(token)
    if (path !== '/auth/login' && path !== '/auth/register') reportAuthFailure(error, token)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
  return request<T>(path, { method: 'GET' }, timeoutMs)
}

export function apiPost<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs)
}

export function apiPostMultipart<T>(path: string, formData: FormData): Promise<T> {
  return request<T>(path, { method: 'POST', body: formData })
}

export function apiPut<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) }, timeoutMs)
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}
