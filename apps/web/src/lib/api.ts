const API_BASE = '/api'
const TOKEN_KEY = 'aisec_token'

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken()
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
  if (json.code !== 0) throw new Error(`API error: ${message || '请求未成功，请重试。'}`)
  if (!Object.prototype.hasOwnProperty.call(json, 'data'))
    throw new Error('服务返回的报文格式异常，请稍后重试。')
  return json.data
}

export async function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs == null ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: authHeaders(),
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    })
    return await handle<T>(res)
  } finally {
    clearTimeout(timer)
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return handle<T>(res)
}

export async function apiPostMultipart<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  })
  return handle<T>(res)
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return handle<T>(res)
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return handle<T>(res)
}
