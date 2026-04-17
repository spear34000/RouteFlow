# RouteFlow 사용 가이드

이 문서는 "무엇을 어떻게 설계하면 운영에서 덜 고생하는가"에 초점을 둡니다.

## 아키텍처: 정보는 어디에 저장되나

```
┌────────────────────────────────────────┐
│  클라이언트 (브라우저/앱)               │
│  - 구독 상태 (WebSocket/SSE 연결)       │
│  - 화면 데이터 (메모리)                 │
└────────────────────────────────────────┘
                    ↕
┌────────────────────────────────────────┐
│  RouteFlow 서버 (Node.js)              │
│  - 구독자 목록 (경로 → 클라이언트 매핑) │
│  - @Reactive 엔드포인트 캐시           │
└────────────────────────────────────────┘
                    ↕
┌────────────────────────────────────────┐
│  데이터베이스 (영구 저장소)             │
│  - 실제 비즈니스 데이터                 │
│  - CDC (LISTEN/NOTIFY, binlog, …)      │
└────────────────────────────────────────┘
```

데이터 흐름:
```
DB 변경 → Adapter 감지 → 서버 → 구독자 브로드캐스트 → 클라이언트 업데이트
```

처음 읽는 사람이라면 먼저 [`getting-started.md`](./getting-started.md)와 [`examples.md`](./examples.md)를 보고 오는 편이 좋습니다.

---

## 설치

```bash
npm install routeflow-api
```

Node.js 버전 참고:

- SQLite `RouteStore`는 Node.js `22.13+`가 필요합니다.
- 2026-04-17 기준 최신 LTS는 `Node.js 24.15.0 (LTS)`입니다.
- `routeflow-api/sqlite`는 ESM과 CommonJS에서 모두 사용할 수 있습니다.

DB 어댑터가 필요하면 해당 드라이버만 추가합니다.

```bash
npm install routeflow-api pg        # PostgreSQL
npm install routeflow-api mongodb   # MongoDB
npm install routeflow-api mysql2    # MySQL
npm install routeflow-api ioredis   # Redis
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true
  }
}
```

> `reflect-metadata`는 `routeflow-api` 안에 포함되어 있어 별도 설치 불필요.

## 시작 전략

실제 프로젝트에서는 아래 순서가 가장 덜 위험합니다.

1. `Todo` 예제나 `MemoryAdapter`로 전체 흐름을 먼저 확인한다.
2. `Differentiation` 예제로 `push: 'smart'`, query-aware live, `liveInclude`를 확인한다.
3. 로컬에서는 `RouteStore`로 API 형태와 live 엔드포인트를 고정한다.
4. 운영 직전에 `TableStore<T>` 인터페이스를 유지한 채 Postgres 같은 실제 DB로 바꾼다.
5. 마지막으로 `/_health`, request tracing, graceful shutdown을 점검한다.

## RouteFlow를 RouteFlow답게 쓰는 법

아래 세 가지를 먼저 떠올리면 설계가 훨씬 깔끔해집니다.

1. 단순 append/feed형 live route는 `push: 'smart'`부터 쓴다.
2. room, team, project 같은 상위 자원 범위는 `queryFilter`로 고정한다.
3. 화면이 `?include=author` 같은 조합 응답을 직접 쓰면 `liveInclude: true`를 켠다.

예시:

```ts
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

---

## 서버 패턴

### 패턴 1 — RouteStore (SQLite, 파일 저장)

로컬 개발이나 단일 서버 운영에 권장합니다.  
`RouteStore`가 `DatabaseAdapter`와 테이블 CRUD를 하나로 통합합니다.
v1.0.22부터는 테이블별 64개 LRU statement cache를 유지합니다.

```ts
import { createApp, Reactive, Route } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import type { Context } from 'routeflow-api'

const db    = new RouteStore('./data/app.db')
const items = db.table('items', {
  name:      'text',
  createdAt: 'text',
})

await items.seed([
  { name: 'Apple',  createdAt: '2026-01-01T00:00:00.000Z' },
  { name: 'Banana', createdAt: '2026-01-01T00:00:01.000Z' },
])

class ItemController {
  @Route('GET', '/items')
  async list(_ctx: Context) {
    return items.list()
  }

  @Route('POST', '/items')
  async create(ctx: Context) {
    const body = ctx.body as { name: string }
    // create() → DB 저장 + @Reactive WebSocket 푸시 자동 발동
    return items.create({ name: body.name, createdAt: new Date().toISOString() })
  }

  @Route('PUT', '/items/:id')
  async update(ctx: Context) {
    const body = ctx.body as { name?: string }
    return items.update(Number(ctx.params['id']), body) ?? { error: 'Not found' }
  }

  @Route('DELETE', '/items/:id')
  async remove(ctx: Context) {
    return { ok: await items.delete(Number(ctx.params['id'])) }
  }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async live(_ctx: Context) {
    return items.list()
  }
}

const app = createApp({ adapter: db, port: 3000 })
app.register(ItemController)
await app.listen()
```

```js
const { RouteStore } = require('routeflow-api/sqlite')
```

이 패턴이 좋은 경우:

- 혼자 빠르게 MVP를 띄울 때
- 작은 팀이 단일 노드로 운영할 때
- 문서/예제/교육용 샘플을 만들 때

### 패턴 2 — 팩토리 + TableStore\<T\> (백엔드 교체 가능)

컨트롤러가 `TableStore<T>` 인터페이스만 보도록 만들면 SQLite → Postgres → 어떤 DB든 같은 팩토리를 재사용할 수 있습니다.

```ts
import type { TableStore, Context } from 'routeflow-api'
import { Reactive, Route } from 'routeflow-api'

interface Item { id: number; name: string; createdAt: string }

// 팩토리: TableStore<Item>을 받으면 어떤 백엔드든 수용
function createItemController(items: TableStore<Item>) {
  class ItemController {
    @Route('GET', '/items')
    async list(_ctx: Context) { return items.list() }

    @Route('POST', '/items')
    async create(ctx: Context) {
      const body = ctx.body as { name: string }
      return items.create({ name: body.name, createdAt: new Date().toISOString() })
    }

    @Reactive({ watch: 'items' })
    @Route('GET', '/items/live')
    async live(_ctx: Context) { return items.list() }
  }
  return ItemController
}

// --- SQLite (로컬) ---
import { RouteStore } from 'routeflow-api/sqlite'
import { createApp } from 'routeflow-api'

const db    = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })
await items.seed([{ name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' }])

createApp({ adapter: db, port: 3000 })
  .register(createItemController(items))

// --- PostgreSQL (운영) — 컨트롤러 동일 ---
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'

class PgItemStore implements TableStore<Item> {
  async list()           { /* pool.query(...) */ return [] }
  async get(id)          { /* pool.query(...) */ return null }
  async create(data)     { /* pool.query(...) */ return { id: 1, ...data } }
  async update(id, data) { /* pool.query(...) */ return null }
  async delete(id)       { /* pool.query(...) */ return false }
}

const adapter = new PostgresAdapter({ connectionString: process.env.DATABASE_URL! })
createApp({ adapter, port: 3000 })
  .register(createItemController(new PgItemStore()))
```

이 패턴이 좋은 경우:

- 로컬/운영 DB가 다를 때
- ORM이나 query layer를 직접 제어하고 싶을 때
- 테스트에서 store만 바꿔 끼우고 싶을 때

### 패턴 3 — MemoryAdapter (테스트·데모)

빠른 프로토타입이나 테스트에 쓸 때 사용합니다.

```ts
import { createApp, MemoryAdapter, Reactive, Route } from 'routeflow-api'
import type { Context } from 'routeflow-api'

const adapter = new MemoryAdapter()
const data: { id: number; name: string }[] = [{ id: 1, name: 'Apple' }]

class ItemController {
  @Route('GET', '/items')
  async list(_ctx: Context) { return data }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async live(_ctx: Context) { return data }
}

const app = createApp({ adapter, port: 3000 })
app.register(ItemController)
await app.listen()

// 변경 수동 발생
data.push({ id: 2, name: 'Orange' })
adapter.emit('items', { operation: 'INSERT', newRow: { id: 2, name: 'Orange' }, oldRow: null })
```

이 패턴이 좋은 경우:

- 테스트에서 DB 의존성을 완전히 빼고 싶을 때
- 문서 예제를 가장 짧게 유지하고 싶을 때
- 구독/푸시 동작만 빠르게 확인하고 싶을 때

---

## 고급 패턴

### 사용자별 필터링

```ts
@Reactive({
  watch: 'orders',
  filter: (event, ctx) => {
    const row = event.newRow as { userId: string } | null
    return row?.userId === ctx.params['userId']
  },
})
@Route('GET', '/users/:userId/orders/live')
async getUserOrders(ctx: Context) {
  return orders.list({ where: { userId: ctx.params['userId'] } })
}
```

### 디바운스

연속 변경이 몰릴 때 재계산 횟수를 줄입니다.

```ts
@Reactive({ watch: 'logs', debounce: 300 })
@Route('GET', '/logs/live')
async liveLogs(_ctx: Context) {
  return logs.list({ orderBy: 'createdAt', order: 'desc', limit: 50 })
}
```

### SSE

```ts
// 서버
const app = createApp({ adapter, transport: 'sse', port: 3000 })
```

SSE를 먼저 고려할 만한 경우:

- 브라우저 중심 서비스
- 프록시/로드밸런서 환경에서 WebSocket 제약이 있을 때
- 단방향 서버 → 클라이언트 push만 필요할 때

### 커스텀 라우트 (Fastify 직접 접근)

```ts
const fastify = app.getFastify()
fastify.get('/health', async () => ({ status: 'ok' }))
```

기본 제공 운영 엔드포인트도 있습니다.

- `GET /_health`
- `X-Request-ID` 자동 생성/전달
- `SIGTERM`, `SIGINT` graceful shutdown

### PollingAdapter (공식 어댑터 없는 DB)

```ts
import { PollingAdapter } from 'routeflow-api'

const adapter = new PollingAdapter<number>({
  intervalMs: 1_000,
  async readChanges({ table, cursor }) {
    const rows = await db.query(
      'SELECT * FROM change_log WHERE table_name = ? AND id > ? ORDER BY id',
      [table, cursor ?? 0],
    )
    return {
      cursor: rows.at(-1)?.id ?? cursor,
      events: rows.map((r) => ({
        operation: r.operation,
        newRow: r.new_data,
        oldRow: r.old_data,
      })),
    }
  },
})
```

---

## 클라이언트

### 기본 사용법

```ts
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

// REST 스냅샷
const items = await client.get<Item[]>('/items')

// live 구독
const unsubscribe = client.subscribe<Item[]>('/items/live', (latest) => {
  render(latest)
})

// 정리
unsubscribe()
client.destroy()
```

### HTTP 메서드

```ts
await client.get('/items')
await client.post('/items', { name: 'Apple' })
await client.put('/items/1', { name: 'Orange' })
await client.patch('/items/1', { archived: true })
await client.del('/items/1')
```

### 옵션

```ts
const client = createClient('http://localhost:3000', {
  transport: 'websocket',          // 'websocket' | 'sse'
  headers: { Authorization: `Bearer ${token}` },
  reconnect: {
    maxAttempts: 10,
    initialDelayMs: 500,
    backoffFactor: 2,
    maxDelayMs: 30_000,
  },
  onError: (err) => console.error(err),
})
```

### 에러 처리

```ts
import { ReactiveClientError } from 'routeflow-api/client'

try {
  await client.get('/protected')
} catch (err) {
  if (err instanceof ReactiveClientError) {
    console.log(err.status, err.code)
  }
}
```

---

## 프레임워크별 클라이언트

### React

```tsx
import { useEffect, useState } from 'react'
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

interface Item { id: number; name: string }

function ItemList() {
  const [items, setItems] = useState<Item[]>([])

  useEffect(() => {
    client.get<Item[]>('/items').then(setItems)
    return client.subscribe<Item[]>('/items/live', setItems)
  }, [])

  return <ul>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>
}
```

### Vue

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { createClient } from 'routeflow-api/client'

interface Item { id: number; name: string }

const client = createClient('http://localhost:3000')
const items  = ref<Item[]>([])
let unsubscribe: (() => void) | undefined

onMounted(async () => {
  items.value = await client.get<Item[]>('/items')
  unsubscribe  = client.subscribe<Item[]>('/items/live', (data) => { items.value = data })
})

onUnmounted(() => unsubscribe?.())
</script>

<template>
  <ul><li v-for="item in items" :key="item.id">{{ item.name }}</li></ul>
</template>
```

### Svelte

```svelte
<script lang="ts">
import { createClient } from 'routeflow-api/client'
import { onMount, onDestroy } from 'svelte'

interface Item { id: number; name: string }

const client = createClient('http://localhost:3000')
let items: Item[] = []
let unsubscribe: (() => void) | undefined

onMount(async () => {
  items       = await client.get<Item[]>('/items')
  unsubscribe = client.subscribe<Item[]>('/items/live', (data) => { items = data })
})

onDestroy(() => unsubscribe?.())
</script>

<ul>{#each items as item}<li>{item.name}</li>{/each}</ul>
```

---

## 베스트 프랙티스

| 상황 | 권장 |
|---|---|
| 로컬 개발 / 단일 서버 | `RouteStore` |
| 멀티 백엔드 대응 | `TableStore<T>` 팩토리 패턴 |
| 테스트 / 데모 | `MemoryAdapter` |
| 운영 DB | 해당 네이티브 어댑터 |

- 첫 화면은 `get()`으로 스냅샷, 이후 `/live` 경로를 `subscribe()`
- 화면/컴포넌트 언마운트 시 반드시 `unsubscribe()` 호출
- 사용자별 데이터가 다를 때는 `filter` 옵션으로 구독 범위를 좁힘
- 변경이 폭발적으로 몰리는 경우 `debounce` 사용

---

## 참고 문서

- [시작하기](./getting-started.md)
- [서버 API](./server.md)
- [클라이언트 API](./client.md)
- [어댑터](./adapters.md)
