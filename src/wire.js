/**
 * HTTP wire helpers for the `/remote/api` route.
 * @module dsh-remote-ssh/wire
 */

/** Error carrying a stable code so the client can branch on failures. */
export class ApiError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Send one JSON body. */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Success envelope. */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** Failure envelope; unknown errors become 500 without leaking a stack. */
export function writeError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const message = typeof error?.message === 'string' ? error.message : '内部错误'
  writeJson(res, status, { ok: false, error: { code, message, details: error?.details } })
}

/**
 * Read a JSON request body with a hard size ceiling.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum bytes accepted.
 * @returns {Promise<object>} the parsed object (`{}` for an empty body).
 */
export async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ApiError('body-too-large', '请求体过大', 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError('bad-body', '请求体必须是 JSON 对象', 400)
    }
    return parsed
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('bad-json', '请求体不是合法 JSON', 400)
  }
}

/** Require a non-empty string field. */
export function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('missing-field', `缺少字段 ${key}`, 400)
  }
  return value
}

/** Optional string field with a default. */
export function optionalString(payload, key, fallback) {
  const value = payload?.[key]
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Require an absolute local path (downloads must never be relative guesses). */
export function requireAbsolutePath(value, key) {
  const path = requireString({ [key]: value }, key)
  const normalised = path.replaceAll('\\', '/')
  if (!/^([a-zA-Z]:\/|\/)/.test(normalised)) {
    throw new ApiError('bad-path', `${key} 必须是绝对路径`, 400)
  }
  return path
}
