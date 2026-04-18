# routeflow-api

[![npm version](https://img.shields.io/npm/v/routeflow-api)](https://www.npmjs.com/package/routeflow-api)
[![npm downloads](https://img.shields.io/npm/dw/routeflow-api)](https://www.npmjs.com/package/routeflow-api)
[![CI](https://img.shields.io/github/actions/workflow/status/spear34000/RouteFlow/ci.yml?branch=main&label=CI)](https://github.com/spear34000/RouteFlow/actions/workflows/ci.yml)

Keep your REST API and add live endpoints with query-aware subscriptions and smart delta push.

> REST처럼 쓰는데, 쿼리와 관계까지 이해해서 바뀐 것만 실시간으로 푸시됩니다.

- Query-aware live subscriptions
- Smart delta push
- Live include responses

## Why RouteFlow

RouteFlow is for teams that want to keep their REST API shape, but do not want to rebuild a separate realtime layer for:

- query-specific fan-out
- scoped subscriptions like room, team, or project feeds
- relation-aware responses such as `?include=author`
- deciding when delta push is safe and when snapshot fallback is safer

Instead of designing events first, RouteFlow lets you make existing routes live.

## What It Solves

- Live REST endpoints backed by database changes
- Query-aware subscriptions
- Smart delta push for simple feed-style routes
- Live include recomputation when related data changes
- Adapter-based architecture without hard vendor lock-in

## Install

```bash
npm install routeflow-api
```

For PostgreSQL:
```bash
npm install routeflow-api pg
```

## Project health

- Issues: [GitHub Issues](https://github.com/spear34000/RouteFlow/issues)
- Contributing: [CONTRIBUTING.md](https://github.com/spear34000/RouteFlow/blob/main/CONTRIBUTING.md)
- Security: [SECURITY.md](https://github.com/spear34000/RouteFlow/blob/main/SECURITY.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](https://github.com/spear34000/RouteFlow/blob/main/CODE_OF_CONDUCT.md)
- Support: [SUPPORT.md](https://github.com/spear34000/RouteFlow/blob/main/SUPPORT.md)

## Node.js compatibility

- Core server/client features work on current Node.js LTS lines.
- SQLite support via `routeflow-api/sqlite` requires Node.js `22.13+`.
- As of 2026-04-17, the latest LTS is `Node.js 24.15.0 (LTS)`, which is the recommended runtime for SQLite usage.
- The SQLite entry now works in both ESM imports and CommonJS `require()`.

## Usage

### Why it feels different

```typescript
app.flow('/rooms/:roomId/messages', messages, {
  push: 'smart',
  queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
  query: 'auto',
  relations: {
    author: { store: users, foreignKey: 'authorId' },
  },
  liveInclude: true,
})
```

이 설정 하나로:

- room-scoped live fan-out
- 안전한 경우 delta, 아니면 snapshot fallback
- `?include=author` 응답의 relation 변경 재계산

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
