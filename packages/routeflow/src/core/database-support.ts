export type DatabaseCategory =
  | 'rdbms'
  | 'nosql'
  | 'time-series'
  | 'search-engine'
  | 'cloud-data-warehouse'
  | 'in-memory'
  | 'newsql'

export type DatabaseSupportMode = 'native-adapter' | 'polling-adapter' | 'external-cdc-bridge'
export type DatabaseSupportTier = 'official' | 'experimental'

export type DatabaseKey =
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'oracle-db'
  | 'ms-sql-server'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'cassandra'
  | 'dynamodb'
  | 'neo4j'
  | 'elasticsearch'
  | 'hbase'
  | 'couchdb'
  | 'influxdb'
  | 'timescaledb'
  | 'prometheus'
  | 'opensearch'
  | 'solr'
  | 'snowflake'
  | 'bigquery'
  | 'redshift'
  | 'azure-synapse'
  | 'memcached'
  | 'voltdb'
  | 'cockroachdb'
  | 'tidb'
  | 'spanner'

export interface DatabaseSupportDescriptor {
  key: DatabaseKey
  name: string
  aliases: string[]
  categories: DatabaseCategory[]
  supportedModes: DatabaseSupportMode[]
  tier: DatabaseSupportTier
}

export const SUPPORTED_DATABASES: readonly DatabaseSupportDescriptor[] = [
  {
    key: 'postgresql',
    name: 'PostgreSQL',
    aliases: ['postgres', 'psql'],
    categories: ['rdbms'],
    supportedModes: ['native-adapter', 'polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'mysql',
    name: 'MySQL',
    aliases: [],
    categories: ['rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'mariadb',
    name: 'MariaDB',
    aliases: [],
    categories: ['rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'oracle-db',
    name: 'Oracle DB',
    aliases: ['oracle', 'oracle database'],
    categories: ['rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'ms-sql-server',
    name: 'MS SQL Server',
    aliases: ['sql server', 'mssql', 'ms sql'],
    categories: ['rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'sqlite',
    name: 'SQLite',
    aliases: [],
    categories: ['rdbms'],
    supportedModes: ['polling-adapter'],
    tier: 'experimental',
  },
  {
    key: 'mongodb',
    name: 'MongoDB',
    aliases: ['mongo'],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'redis',
    name: 'Redis',
    aliases: [],
    categories: ['nosql', 'in-memory'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'cassandra',
    name: 'Cassandra',
    aliases: ['apache cassandra'],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'dynamodb',
    name: 'DynamoDB',
    aliases: ['dynamo'],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'neo4j',
    name: 'Neo4j',
    aliases: [],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'elasticsearch',
    name: 'Elasticsearch',
    aliases: ['elastic'],
    categories: ['nosql', 'search-engine'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'hbase',
    name: 'HBase',
    aliases: ['apache hbase'],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'couchdb',
    name: 'CouchDB',
    aliases: ['apache couchdb'],
    categories: ['nosql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'influxdb',
    name: 'InfluxDB',
    aliases: ['influx'],
    categories: ['time-series'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'timescaledb',
    name: 'TimescaleDB',
    aliases: ['timescale'],
    categories: ['time-series', 'rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'prometheus',
    name: 'Prometheus',
    aliases: ['prom'],
    categories: ['time-series'],
    supportedModes: ['polling-adapter'],
    tier: 'experimental',
  },
  {
    key: 'opensearch',
    name: 'OpenSearch',
    aliases: [],
    categories: ['search-engine'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'solr',
    name: 'Solr',
    aliases: ['apache solr'],
    categories: ['search-engine'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'snowflake',
    name: 'Snowflake',
    aliases: [],
    categories: ['cloud-data-warehouse'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'official',
  },
  {
    key: 'bigquery',
    name: 'BigQuery',
    aliases: ['google bigquery'],
    categories: ['cloud-data-warehouse'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'redshift',
    name: 'Redshift',
    aliases: ['amazon redshift'],
    categories: ['cloud-data-warehouse'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'azure-synapse',
    name: 'Azure Synapse',
    aliases: ['synapse', 'azure synapse analytics'],
    categories: ['cloud-data-warehouse'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'memcached',
    name: 'Memcached',
    aliases: [],
    categories: ['in-memory'],
    supportedModes: ['polling-adapter'],
    tier: 'experimental',
  },
  {
    key: 'voltdb',
    name: 'VoltDB',
    aliases: [],
    categories: ['in-memory'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'cockroachdb',
    name: 'CockroachDB',
    aliases: ['cockroach'],
    categories: ['newsql', 'rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'tidb',
    name: 'TiDB',
    aliases: [],
    categories: ['newsql', 'rdbms'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
  {
    key: 'spanner',
    name: 'Spanner',
    aliases: ['google spanner', 'cloud spanner'],
    categories: ['newsql'],
    supportedModes: ['polling-adapter', 'external-cdc-bridge'],
    tier: 'experimental',
  },
] as const

function normaliseDatabaseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function getDatabaseSupport(name: string): DatabaseSupportDescriptor | undefined {
  const normalised = normaliseDatabaseName(name)

  return SUPPORTED_DATABASES.find((database) => {
    if (normaliseDatabaseName(database.name) === normalised) return true
    if (normaliseDatabaseName(database.key) === normalised) return true

    return database.aliases.some((alias) => normaliseDatabaseName(alias) === normalised)
  })
}

export function listSupportedDatabases(
  category?: DatabaseCategory,
): readonly DatabaseSupportDescriptor[] {
  if (!category) return SUPPORTED_DATABASES
  return SUPPORTED_DATABASES.filter((database) => database.categories.includes(category))
}

export function listOfficialDatabases(
  category?: DatabaseCategory,
): readonly DatabaseSupportDescriptor[] {
  const databases = listSupportedDatabases(category)
  return databases.filter((database) => database.tier === 'official')
}
