import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_DATABASES,
  getDatabaseSupport,
  listOfficialDatabases,
  listSupportedDatabases,
} from './database-support.js'

describe('database support registry', () => {
  it('includes every requested database exactly once', () => {
    expect(SUPPORTED_DATABASES).toHaveLength(28)
    expect(new Set(SUPPORTED_DATABASES.map((database) => database.key)).size).toBe(28)
  })

  it('resolves aliases and canonical names', () => {
    expect(getDatabaseSupport('postgres')).toMatchObject({ key: 'postgresql' })
    expect(getDatabaseSupport('SQL Server')).toMatchObject({ key: 'ms-sql-server' })
    expect(getDatabaseSupport('Cloud Spanner')).toMatchObject({ key: 'spanner' })
  })

  it('filters by category', () => {
    const searchEngines = listSupportedDatabases('search-engine').map((database) => database.key)

    expect(searchEngines).toEqual(['elasticsearch', 'opensearch', 'solr'])
  })

  it('exposes the official support set separately', () => {
    const official = listOfficialDatabases().map((database) => database.key)

    expect(official).toEqual([
      'postgresql',
      'mysql',
      'mongodb',
      'redis',
      'dynamodb',
      'elasticsearch',
      'opensearch',
      'snowflake',
    ])
  })
})
