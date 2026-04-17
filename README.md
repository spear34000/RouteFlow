# RouteFlow

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Transport](https://img.shields.io/badge/Transport-WebSocket%20%7C%20SSE-16110F)](#공식-지원)
[![Adapters](https://img.shields.io/badge/Official%20Adapters-8-DB5C34)](#공식-지원)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue)](./LICENSE)

> **"REST처럼 쓰는데, DB 변경이 생기면 구독 중인 클라이언트에 자동으로 푸시된다."**

RouteFlow는 기존 REST API 작성 방식을 유지하면서, DB 변경이 생기면 해당 엔드포인트를 구독 중인 클라이언트에게 최신 결과를 자동 푸시하는 반응형 백엔드 프레임워크입니다.

Supabase Realtime·Firebase·Prisma Pulse와 달리 특정 플랫폼에 종속되지 않는 어댑터 패턴으로 설계되었습니다.

## 문서

- [`docs/getting-started.md`](./docs/getting-started.md)
- [`docs/server.md`](./docs/server.md)
- [`docs/client.md`](./docs/client.md)
- [`docs/adapters.md`](./docs/adapters.md)
- [`docs/examples.md`](./docs/examples.md)
- [`docs/releases/v1.0.22.md`](./docs/releases/v1.0.22.md)
- [`SKILLS.md`](./SKILLS.md)

## 설치

```bash
npm install routeflow-api
```

PostgreSQL 어댑터를 같이 쓰려면:

```bash
npm install routeflow-api pg
```

> `reflect-metadata`는 `routeflow-api`에 포함되어 있으므로 별도 설치가 필요 없습니다.

## Node.js 호환성

- 코어 HTTP/WebSocket/SSE 기능은 현재 Node.js LTS 환경에서 사용할 수 있습니다.
- SQLite `RouteStore`는 내장 `node:sqlite`를 사용하므로 Node.js `22.13+`가 필요합니다.
- 2026-04-17 기준 최신 LTS는 `Node.js 24.15.0 (LTS)`이며, SQLite 사용 시 이 버전을 권장합니다.
- `routeflow-api/sqlite`는 이제 ESM과 CommonJS `require()` 양쪽에서 동작합니다.

---

## 빠른 시작

### 5분 체험

가장 빠른 시작은 Todo 예제입니다.

```bash
pnpm install
pnpm run example:todos
```

다른 터미널에서:

```bash
curl http://localhost:3020/todos

curl -X POST http://localhost:3020/todos \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship RouteFlow docs","done":0,"createdAt":"2026-04-17T00:00:00.000Z"}'
```

자동 검증:

```bash
pnpm run example:todos:smoke
```

이 smoke test는 실제 예제 서버를 띄우고 `GET /todos`, `POST /todos`, `/todos/live` push까지 확인합니다.

### 파일 저장 서버 (SQLite, 권장)

`RouteStore`는 DatabaseAdapter와 테이블 CRUD를 하나로 통합합니다.
Node.js 22.13+ 내장 `node:sqlite`를 사용하므로 추가 패키지가 없습니다.

```typescript
import { createApp, Reactive, Route } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import type { Context } from 'routeflow-api'

const db    = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })

await items.seed([{ name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' }])

class ItemController {
  @Route('GET', '/items')
  async getItems(_ctx: Context) {
    return items.list()
  }

  @Route('POST', '/items')
  async createItem(ctx: Context) {
    const body = ctx.body as { name: string }
    // create() → DB 저장 + @Reactive WebSocket 푸시 자동 발동
    return items.create({ name: body.name, createdAt: new Date().toISOString() })
  }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async getLiveItems(_ctx: Context) {
    return items.list()
  }
}

const app = createApp({ adapter: db, port: 3000 })
app.register(ItemController)
await app.listen()
```

### 인메모리 서버 (테스트·데모)

```typescript
import { createApp, Reactive, Route, MemoryAdapter } from 'routeflow-api'
import type { Context } from 'routeflow-api'

const adapter = new MemoryAdapter()
const data    = [{ id: 1, name: 'Apple' }]

class ItemController {
  @Route('GET', '/items')
  async getItems(_ctx: Context) { return data }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async getLiveItems(_ctx: Context) { return data }
}

const app = createApp({ adapter, port: 3000 })
app.register(ItemController)
await app.listen()

// 변경을 수동으로 발생시켜 구독자에 푸시
data.push({ id: 2, name: 'Orange' })
adapter.emit('items', { operation: 'INSERT', newRow: { id: 2, name: 'Orange' }, oldRow: null })
```

### 클라이언트

```typescript
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

// REST 스냅샷
const items = await client.get('/items')

// live 구독 — DB 변경 시 자동 수신
const unsubscribe = client.subscribe('/items/live', (latest) => {
  console.log('업데이트:', latest)
})
```

---

## 어댑터 교체 — 컨트롤러 코드 불변

컨트롤러는 `TableStore<T>` 인터페이스만 봅니다. 백엔드가 바뀌어도 핸들러 코드는 그대로입니다.

```ts
import type { TableStore } from 'routeflow-api'

function createItemController(items: TableStore<Item>) {
  class ItemController {
    @Route('GET', '/items')
    async getItems(_ctx: Context) { return items.list() }

    @Reactive({ watch: 'items' })
    @Route('GET', '/items/live')
    async getLiveItems(_ctx: Context) { return items.list() }
  }
  return ItemController
}

// SQLite (로컬)
const db    = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })
createApp({ adapter: db, port: 3000 }).register(createItemController(items))

// PostgreSQL (운영) — 같은 팩토리
const store   = new PostgresItemStore(pool)   // implements TableStore<Item>
const adapter = new PostgresAdapter({ connectionString })
createApp({ adapter, port: 3000 }).register(createItemController(store))
```

---

## .routeflow 폴더

서버 시작 시 프로젝트 루트에 `.routeflow/info.json`이 자동 생성됩니다.

```json
{
  "port": 3000,
  "transport": "websocket",
  "adapter": "RouteStore",
  "routes": [
    { "method": "GET",  "path": "/items",      "reactive": false },
    { "method": "POST", "path": "/items",      "reactive": false },
    { "method": "GET",  "path": "/items/live", "reactive": true  }
  ],
  "startedAt": "2026-04-13T00:00:00.000Z"
}
```

`.gitignore`에 추가를 권장합니다.

```
.routeflow/
```

---

## 패키지

| import 경로 | 설명 |
|---|---|
| `routeflow-api` | 코어 — `createApp`, `@Route`, `@Reactive`, `TableStore`, `MemoryAdapter`, `PollingAdapter` |
| `routeflow-api/sqlite` | `RouteStore` — SQLite 통합 어댑터 + 테이블 CRUD |
| `routeflow-api/client` | 브라우저/Node 클라이언트 SDK |
| `routeflow-api/adapters/postgres` | PostgreSQL (LISTEN/NOTIFY) |
| `routeflow-api/adapters/mysql` | MySQL (binlog) |
| `routeflow-api/adapters/mongodb` | MongoDB (Change Streams) |
| `routeflow-api/adapters/redis` | Redis (Pub/Sub) |
| `routeflow-api/adapters/dynamodb` | DynamoDB (Streams) |
| `routeflow-api/adapters/elasticsearch` | Elasticsearch |
| `routeflow-api/adapters/opensearch` | OpenSearch |
| `routeflow-api/adapters/snowflake` | Snowflake |

### 공식 지원 DB

`PostgreSQL` · `MySQL` · `MongoDB` · `Redis` · `DynamoDB` · `Elasticsearch` · `OpenSearch` · `Snowflake`

---

## 예제 실행

```bash
pnpm install
pnpm build

# SQLite 파일 저장 데모 (WebSocket, :3000)
pnpm run example:memory

# SSE 전송 데모 (:3001)
pnpm run example:memory:sse

# Todo 예제 (:3020)
pnpm run example:todos

# Todo smoke test
pnpm run example:todos:smoke

# PostgreSQL 데모 (:3002)
pnpm run example:postgres

# 클라이언트 데모 (다른 터미널에서)
pnpm run example:client
```

브라우저에서 실행 중인 포트를 열면 REST 스냅샷과 live 푸시를 한 화면에서 볼 수 있습니다.

---

## 개발

```bash
pnpm install
pnpm build
pnpm test
```

---

## v1.0.22

운영 환경 기준의 핵심 개선이 들어갔습니다.

- 엔진 구독 라우팅이 전체 구독자 순회에서 endpoint/path 역방향 인덱스 기반으로 바뀌어, fan-out 비용이 전체 연결 수가 아니라 실제 매칭 구독자 수에 비례합니다.
- SQLite `RouteStore`가 테이블별 64개 LRU statement cache를 유지해 반복 CRUD 쿼리의 parse/compile 비용을 줄입니다.
- `SIGTERM`, `SIGINT` graceful shutdown이 기본 동작으로 추가되어 컨테이너 종료 시 in-flight 요청과 DB 연결을 더 안전하게 정리합니다.
- `GET /_health`와 자동 `X-Request-ID` 전파가 기본 제공되어 liveness probe와 요청 추적을 바로 붙일 수 있습니다.

---

## 왜 RouteFlow인가

기존 방식은 HTTP API · WebSocket/SSE · DB 변경 감지 · 클라이언트 이벤트 처리를 각각 따로 다룹니다.  
RouteFlow는 이걸 하나로 묶습니다. 개발자는 기존처럼 라우트를 만들고 `@Reactive`를 붙이면 되고, 프레임워크가 DB 변경을 감지해서 live 엔드포인트 결과를 다시 계산해 푸시합니다.

**장점**
- REST 작성 방식 안에서 실시간 기능을 붙일 수 있음
- WebSocket 프로토콜을 직접 다루지 않아도 됨
- 클라이언트는 경로 기반 구독만으로 최신 결과를 받음
- DB 어댑터를 교체해도 컨트롤러 코드 유지

**한계**
- 변경마다 엔드포인트를 재실행하면 성능 비용이 커질 수 있음
- 멀티 인스턴스 환경에서는 구독 상태 동기화가 추가 과제
