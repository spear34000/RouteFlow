import { describe, expect, it } from 'vitest'
import { OpenSearchAdapter } from './index.js'

describe('OpenSearchAdapter', () => {
  it('re-exports the Elasticsearch adapter implementation', () => {
    expect(typeof OpenSearchAdapter).toBe('function')
  })
})
