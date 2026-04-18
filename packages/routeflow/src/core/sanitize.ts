const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item))
  if (!isPlainObject(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue
    out[key] = sanitizeJsonValue(item)
  }
  return out
}

export function sanitizeStringRecord(
  value: unknown,
  options: { allowArrays?: boolean } = {},
): Record<string, string> {
  if (!value || typeof value !== 'object') return {}

  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue
    if (typeof item === 'string') {
      out[key] = item
    } else if (options.allowArrays && Array.isArray(item) && item.every((part) => typeof part === 'string')) {
      out[key] = item.join(', ')
    }
  }
  return out
}
