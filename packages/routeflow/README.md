# routeflow-api

RouteFlow — REST API with real-time database push subscriptions

> REST처럼 쓰는데, DB 변경이 생기면 구독 중인 클라이언트에 자동으로 푸시됩니다.

## Install

```bash
npm install routeflow-api
```

For PostgreSQL:
```bash
npm install routeflow-api pg
```

## Node.js compatibility

- Core server/client features work on current Node.js LTS lines.
- SQLite support via `routeflow-api/sqlite` requires Node.js `22.13+`.
- As of 2026-04-17, the latest LTS is `Node.js 24.15.0 (LTS)`, which is the recommended runtime for SQLite usage.
- The SQLite entry now works in both ESM imports and CommonJS `require()`.

## Usage

### Server

```typescript
import 'reflect-metadata'
import { createApp, MemoryAdapter, Route, Reactive } from 'routeflow-api'
import type { Context } from 'routeflow-api'

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

## Operational defaults

- `GET /_health` is auto-registered for liveness probes.
- Every HTTP request gets an `X-Request-ID`, exposed in handlers as `ctx.requestId`.
- `SIGTERM` and `SIGINT` trigger graceful shutdown with a 10-second drain window.

## v1.0.22 highlights

- Reactive fan-out now routes by matching endpoint/path groups instead of scanning every subscriber.
- SQLite `RouteStore` keeps a 64-entry per-table LRU statement cache for repeated CRUD queries.
- Health checks, request tracing, and graceful shutdown are built in by default.

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

## SQLite

```typescript
import { RouteStore } from 'routeflow-api/sqlite'

const db = new RouteStore('./data/app.db')
```

```js
const { RouteStore } = require('routeflow-api/sqlite')
```

## License

Apache 2.0
