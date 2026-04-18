import { describe, it, expect } from 'vitest'
import { sanitizeJsonValue, sanitizeStringRecord } from './sanitize.js'

describe('sanitizeStringRecord', () => {
  it('drops dangerous keys and non-string values', () => {
    const parsed = sanitizeStringRecord({
      safe: 'ok',
      __proto__: 'pollute',
      count: 1,
      nested: { value: 'x' },
    })

    expect(parsed).toEqual({ safe: 'ok' })
  })

  it('joins string arrays only when explicitly allowed', () => {
    const parsed = sanitizeStringRecord({
      accept: ['application/json', 'text/plain'],
    }, { allowArrays: true })

    expect(parsed).toEqual({ accept: 'application/json, text/plain' })
  })
})

describe('sanitizeJsonValue', () => {
  it('deeply strips dangerous keys from plain objects and arrays', () => {
    const input = JSON.parse('{"name":"safe","nested":{"__proto__":{"polluted":"x"},"child":[{"ok":1,"constructor":{"bad":1}}]}}')
    const parsed = sanitizeJsonValue(input)

    expect(parsed).toEqual({
      name: 'safe',
      nested: {
        child: [{ ok: 1 }],
      },
    })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
})
