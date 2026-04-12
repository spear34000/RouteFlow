# routeflow

RouteFlow — REST API with real-time database push subscriptions

## Install

```bash
npm install routeflow
```

For PostgreSQL:
```bash
npm install routeflow pg
```

## Usage

### Server

```typescript
import 'reflect-metadata'
import { createApp, MemoryAdapter, Route, Reactive } from 'routeflow'
import type { Context } from 'routeflow'

const adapter = new MemoryAdapter()
const items = [{ id: 1, name: 'Apple' }]

class ItemController {
  @Route('GET', '/items')
  async listItems(_ctx: Context) {
    return items
  }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async listLiveItems(_ctx: Context) {
    return items
  }
}

const app = createApp({ adapter, port: 3000 })
app.register(ItemController)
await app.listen()
```

### Client

```typescript
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

const snapshot = await client.get('/items')

const unsubscribe = client.subscribe('/items/live', (items) => {
  console.log('live update', items)
})
```

### Database Adapters

```typescript
// PostgreSQL
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'

// MongoDB
import { MongoDbAdapter } from 'routeflow-api/adapters/mongodb'

// MySQL
import { MySqlAdapter } from 'routeflow-api/adapters/mysql'

// Redis
import { RedisAdapter } from 'routeflow-api/adapters/redis'

// DynamoDB
import { DynamoDbAdapter } from 'routeflow-api/adapters/dynamodb'

// Elasticsearch
import { ElasticsearchAdapter } from 'routeflow-api/adapters/elasticsearch'

// OpenSearch
import { OpenSearchAdapter } from 'routeflow-api/adapters/opensearch'

// Snowflake
import { SnowflakeAdapter } from 'routeflow-api/adapters/snowflake'

// Cassandra
import { CassandraAdapter } from 'routeflow-api/adapters/cassandra'
```

## License

Apache 2.0
