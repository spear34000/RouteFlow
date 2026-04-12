# RouteFlow

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Transport](https://img.shields.io/badge/Transport-WebSocket%20%7C%20SSE-16110F)](#mvp에서-보여줘야-할-것)
[![Adapters](https://img.shields.io/badge/Official%20Adapters-8-DB5C34)](#공식-지원)
[![Release](https://img.shields.io/badge/Release-v0.1.0-F6C7B8?color=DB5C34)](./docs/releases/v0.1.0.md)

> **"REST처럼 쓰는데, DB 변경이 생기면 구독 중인 클라이언트에 자동으로 푸시된다."**

RouteFlow는 기존 REST API 작성 방식을 유지하면서, DB 변경이 생기면 해당 엔드포인트를 구독 중인 클라이언트에게 최신 결과를 자동 푸시하는 반응형 백엔드 프레임워크입니다.

제품명, 패키지 스코프, 문서 예제는 모두 `RouteFlow` 기준으로 정리합니다.

기존 Supabase Realtime·Firebase·Prisma Pulse와 달리 특정 플랫폼에 종속되지 않는 어댑터 패턴으로 설계되었습니다.

## 문서

- [`docs/getting-started.md`](./docs/getting-started.md)
- [`docs/server.md`](./docs/server.md)
- [`docs/client.md`](./docs/client.md)
- [`docs/adapters.md`](./docs/adapters.md)
- [`docs/README.md`](./docs/README.md)
- [`docs/releases/v0.1.0.md`](./docs/releases/v0.1.0.md)

## 데모 진입점

- `http://localhost:3000` - Memory + WebSocket
- `http://localhost:3001` - Memory + SSE
- `http://localhost:3002` - PostgreSQL + WebSocket
- `http://localhost:3003` - PostgreSQL + SSE

### Demo Preview

Memory adapter with WebSocket:

![RouteFlow memory websocket demo](./assets/demo-memory-websocket.png)

Memory adapter with SSE:

![RouteFlow memory sse demo](./assets/demo-memory-sse.png)

## 왜 RouteFlow인가

기존 방식은 보통 다음을 각각 따로 다룹니다.

- HTTP API
- WebSocket/SSE
- DB 변경 감지
- 클라이언트 이벤트 처리

RouteFlow는 이걸 하나로 묶습니다. 개발자는 기존처럼 라우트를 만들고 `@Reactive`를 붙이면 되고, 프레임워크가 DB 변경을 감지해서 해당 live 엔드포인트 결과를 다시 계산해 푸시합니다. 즉, 실시간 기능을 API 바깥의 별도 시스템으로 붙이는 게 아니라, API 자체를 live하게 만드는 것이 차이점입니다.

## MVP에서 보여줘야 할 것

- 한 줄짜리 live 경험: `@Reactive`를 붙였더니 DB 변경 후 자동으로 최신 결과가 온다
- 어댑터 교체 가능성: DB가 달라도 API 코드는 거의 유지된다
- 낮은 인지부하: 실시간인데도 개발자는 REST 쓰듯 쓴다

이 세 장면이 선명해야 사용자가 `왜 RouteFlow인지` 바로 이해할 수 있습니다.

### Memory -> PostgreSQL, controller unchanged

```ts
const ItemController = createItemController(store, emitter)

createApp({
  adapter: new MemoryAdapter(),
  port: 3000,
}).register(ItemController)
```

```ts
const ItemController = createItemController(store)

createApp({
  adapter: new PostgresAdapter({ connectionString: process.env.ROUTEFLOW_POSTGRES_URL! }),
  port: 3000,
}).register(ItemController)
```

같은 라우트 코드를 유지하고, 바뀌는 건 어댑터와 저장소 wiring뿐입니다.

---

## 패키지

### 공식 지원

`PostgreSQL` · `MySQL` · `MongoDB` · `Redis` · `DynamoDB` · `Elasticsearch` · `OpenSearch` · `Snowflake`

| 패키지 | 설명 |
|---|---|
| [`@routeflow/core`](./packages/core) | 프레임워크 코어 — 라우팅, 반응형 엔진, WS/SSE 전송 |
| [`@routeflow/adapter-postgres`](./packages/adapter-postgres) | PostgreSQL 어댑터 (LISTEN/NOTIFY) |
| [`@routeflow/adapter-mysql`](./packages/adapter-mysql) | MySQL 어댑터 (binlog event source) |
| [`@routeflow/adapter-mongodb`](./packages/adapter-mongodb) | MongoDB 어댑터 (Change Streams) |
| [`@routeflow/adapter-redis`](./packages/adapter-redis) | Redis 어댑터 (pub/sub) |
| [`@routeflow/adapter-elasticsearch`](./packages/adapter-elasticsearch) | Elasticsearch 어댑터 (external change source) |
| [`@routeflow/adapter-opensearch`](./packages/adapter-opensearch) | OpenSearch 어댑터 (external change source) |
| [`@routeflow/adapter-dynamodb`](./packages/adapter-dynamodb) | DynamoDB 어댑터 (Streams source) |
| [`@routeflow/adapter-snowflake`](./packages/adapter-snowflake) | Snowflake 어댑터 (stream/task source) |
| [`@routeflow/client`](./packages/client) | 브라우저/Node 클라이언트 SDK |

### 실험적/보류

`MariaDB` · `MS SQL Server` · `SQLite` · `BigQuery` · `Redshift` 등은 지원 매트릭스에는 남겨두되, 현재는 공식 패키지 라인업으로 취급하지 않습니다.

---

## 빠른 시작

### 서버

```typescript
import { createApp, Reactive, Route } from '@routeflow/core'
import { MemoryAdapter } from '@routeflow/core/adapters'
import type { Context } from '@routeflow/core'

const adapter = new MemoryAdapter()
const app = createApp({ adapter, port: 3000 })

class ItemController {
  @Route('GET', '/items')
  async getItems(_ctx: Context) {
    return [{ id: 1, name: 'Apple' }]
  }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async getLiveItems(_ctx: Context) {
    return [{ id: 1, name: 'Apple' }]
  }
}

app.register(ItemController)
await app.listen()

// 변경 발생 시 → 구독 클라이언트에 자동 푸시
adapter.emit('items', { operation: 'INSERT', newRow: { id: 2 }, oldRow: null })
```

### 클라이언트

```typescript
import { createClient } from '@routeflow/client'

const client = createClient('http://localhost:3000')

// 일반 REST
const items = await client.get('/items')

// 실시간 구독
const unsubscribe = client.subscribe('/items/live', (data) => {
  console.log('업데이트:', data)
})
```

### PostgreSQL

```typescript
import { createApp, Reactive, Route } from '@routeflow/core'
import { PostgresAdapter } from '@routeflow/adapter-postgres'

const app = createApp({
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  port: 3000,
})
```

### 기타 DB 공통 지원

`@routeflow/core`는 `PollingAdapter`와 지원 매트릭스를 제공하므로, PostgreSQL 외 DB도 같은 API로 수용할 수 있습니다.

```typescript
import { createApp } from '@routeflow/core'
import { PollingAdapter } from '@routeflow/core/adapters'

const adapter = new PollingAdapter<string>({
  intervalMs: 1_000,
  async readChanges({ table, cursor }) {
    const rows = await loadChangesFromYourDatabase(table, cursor)
    return {
      cursor: rows.at(-1)?.cursor ?? cursor,
      events: rows.map((row) => ({
        operation: row.operation,
        newRow: row.newRow,
        oldRow: row.oldRow,
      })),
    }
  },
})

createApp({ adapter, port: 3000 })
```

### 공식 지원 DB

| DB | 상태 | 비고 |
|---|---|---|
| PostgreSQL | `official` | 네이티브 패키지 |
| MySQL | `official` | 네이티브 패키지 |
| MongoDB | `official` | 네이티브 패키지 |
| Redis | `official` | 네이티브 패키지 |
| DynamoDB | `official` | 네이티브 패키지 |
| Elasticsearch | `official` | 네이티브 패키지 |
| OpenSearch | `official` | 네이티브 패키지 |
| Snowflake | `official` | 네이티브 패키지 |

### 실험적/보류 DB

- MariaDB, Oracle DB, MS SQL Server, SQLite
- Cassandra, Neo4j, HBase, CouchDB
- InfluxDB, TimescaleDB, Prometheus
- Solr
- BigQuery, Redshift, Azure Synapse
- Memcached, VoltDB
- CockroachDB, TiDB, Spanner

`@routeflow/core`의 지원 매트릭스는 DB별로 `tier`, `supportedModes`를 함께 제공합니다. `listOfficialDatabases()`를 쓰면 공식 지원 DB만 바로 가져올 수 있습니다.

```typescript
import { listOfficialDatabases } from '@routeflow/core'

console.log(listOfficialDatabases().map((db) => db.name))
```

---

## 예제 실행

```bash
pnpm install
pnpm build

# 기본 메모리 데모 (WebSocket, :3000)
pnpm run example:memory

# 메모리 데모 (SSE, :3001)
pnpm run example:memory:sse

# Postgres 데모 (WebSocket, :3002)
# ROUTEFLOW_POSTGRES_URL을 지정하지 않으면 postgresql://localhost:5432/routeflow 를 사용
pnpm run example:postgres

# Postgres 데모 (SSE, :3003)
pnpm run example:postgres:sse

# 다른 터미널에서 Node 클라이언트 데모
pnpm run example:client
```

브라우저에서 `http://localhost:3000`, `:3001`, `:3002`, `:3003` 중 실행한 포트를 열면 REST 스냅샷과 live 푸시를 한 화면에서 볼 수 있습니다.

### MVP 데모 포인트

`examples/basic`은 워크스페이스 패키지가 아니라, 그대로 읽고 실행할 수 있는 예제 코드 디렉토리입니다.

- `pnpm run example:memory`
  같은 컨트롤러 코드에 `MemoryAdapter`를 붙여 `@Reactive` 하나로 live 엔드포인트가 동작합니다.
- `pnpm run example:memory:sse`
  전송 레이어만 `SSE`로 바꿔도 브라우저 데모와 구독 API는 거의 그대로 유지됩니다.
- `pnpm run example:postgres`
  같은 컨트롤러 코드를 Postgres 저장소 + `PostgresAdapter`에 연결합니다.
- `pnpm run example:postgres:sse`
  실제 DB + SSE 조합도 같은 경로 기반 구독 모델로 동작합니다.
- `pnpm run example:client`
  클라이언트는 REST 호출 후 `subscribe('/items/live')`만 사용하고, WS 이벤트 포맷은 직접 다루지 않습니다.

---

## 개발

```bash
pnpm install        # 의존성 설치
pnpm build          # 전체 빌드
pnpm test           # 전체 테스트
```

### 통합 테스트 (PostgreSQL 필요)

```bash
POSTGRES_TEST_URL=postgresql://user:pass@localhost:5432/testdb \
  pnpm --filter @routeflow/adapter-postgres test:integration
```

---

## 구현 현황

- [x] Phase 1 — 코어 기반 (라우팅, 반응형 엔진, WebSocket, MemoryAdapter)
- [x] Phase 2 — PostgreSQL 어댑터 (LISTEN/NOTIFY)
- [x] Phase 3 — 클라이언트 SDK (자동 재연결, 구독 복원)
- [x] Phase 4 — SSE 전송, 에러 핸들링, 예제

## 장점

- 기존 REST API 작성 방식 안에서 실시간 기능을 붙일 수 있음
- 개발자가 WebSocket 프로토콜을 직접 다루지 않아도 됨
- 클라이언트는 경로 기반 구독만으로 최신 결과를 받을 수 있음
- DB 어댑터를 교체해도 상위 API 모델을 최대한 유지할 수 있음
- 서버부터 클라이언트까지 타입을 연결하기 좋음

## 단점

- 어떤 DB 변경이 어떤 구독자에게 영향 주는지 판별이 까다로움
- 변경마다 엔드포인트를 재실행하면 성능 비용이 커질 수 있음
- 조인, 권한, 파생 데이터가 섞이면 갱신 범위 추적이 어려움
- 추상화를 많이 숨길수록 디버깅 난도가 올라감
- 멀티 인스턴스 환경에서는 구독 상태 동기화가 추가 과제임

## 포지션

RouteFlow는 그냥 웹 프레임워크도, 특정 실시간 DB 서비스도 아닙니다.

가장 정확한 포지션은 다음입니다.

> 기존 Node/TypeScript 백엔드 개발자가, DB를 바꾸지 않고도 REST 스타일로 실시간 API를 만들 수 있게 해주는 프레임워크
