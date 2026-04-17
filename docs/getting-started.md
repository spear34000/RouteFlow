# Getting Started

RouteFlow는 기존 REST API처럼 라우트를 만들고, live 엔드포인트에만 `@Reactive`를 붙이는 방식으로 사용합니다.

## 1. 설치

```bash
npm install routeflow-api
```

`tsconfig.json`에는 아래 옵션이 필요합니다.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

> `reflect-metadata`는 `routeflow-api` 안에 포함되어 있으므로 별도 설치 불필요합니다.

Node.js 버전 참고:

- 코어 기능은 현재 Node.js LTS 라인에서 사용 가능합니다.
- SQLite `RouteStore`는 `node:sqlite`를 쓰므로 Node.js `22.13+`가 필요합니다.
- 2026-04-17 기준 최신 LTS는 `Node.js 24.15.0 (LTS)`이며, SQLite 예제는 이 버전을 권장합니다.

---

## 2. 서버 만들기

### 인메모리 (빠른 시작)

```ts
import { createApp, MemoryAdapter, Reactive, Route } from 'routeflow-api'
import type { Context } from 'routeflow-api'

const adapter = new MemoryAdapter()
const items   = [{ id: 1, name: 'Apple' }]

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

// 변경을 직접 발생시키기
items.push({ id: 2, name: 'Orange' })
adapter.emit('items', { operation: 'INSERT', newRow: { id: 2, name: 'Orange' }, oldRow: null })
```

### 파일 저장 (SQLite, 데이터 유지)

서버 재시작 후에도 데이터를 유지하려면 `RouteStore`를 씁니다.
Node.js 22.13+ 내장 `node:sqlite`를 사용하므로 추가 패키지 설치가 없습니다.

```ts
import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import type { Context } from 'routeflow-api'

// RouteStore = DatabaseAdapter + 테이블 CRUD 통합
const db    = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })

await items.seed([
  { name: 'Apple',  createdAt: '2026-01-01T00:00:00.000Z' },
])

class ItemController {
  @Route('GET', '/items')
  async listItems(_ctx: Context) {
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
  async listLiveItems(_ctx: Context) {
    return items.list()
  }
}

const app = createApp({ adapter: db, port: 3000 })  // db가 어댑터 역할도 함
app.register(ItemController)
await app.listen()
```

CommonJS 프로젝트에서도 사용할 수 있습니다.

```js
const { RouteStore } = require('routeflow-api/sqlite')
```

---

## 3. 클라이언트에서 구독하기

```ts
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

// REST 스냅샷
const snapshot = await client.get('/items')
console.log(snapshot)

// live 구독
const unsubscribe = client.subscribe('/items/live', (nextItems) => {
  console.log('live update', nextItems)
})

// 정리
unsubscribe()
```

클라이언트는 WebSocket 메시지 포맷이나 채널 이름을 알 필요가 없습니다. 경로만 구독하면 됩니다.

---

## 4. 전송 방식 바꾸기

서버:

```ts
createApp({ adapter, transport: 'sse', port: 3000 })
```

클라이언트:

```ts
createClient('http://localhost:3000', { transport: 'sse' })
```

`subscribe()` 호출 방식은 그대로 유지됩니다.

## 4-1. 기본 운영 기능

RouteFlow는 앱 시작 시 다음 기능을 자동으로 제공합니다.

- `GET /_health`
- 요청별 `X-Request-ID` 생성 또는 전달
- `SIGTERM`, `SIGINT` graceful shutdown

운영용 상세 설명은 [`server.md`](./server.md), 릴리스 변경점은 [`releases/v1.0.22.md`](./releases/v1.0.22.md)를 참고하세요.

---

## 5. 실제 DB로 바꾸기

`RouteStore`나 `MemoryAdapter` 대신 공식 어댑터를 연결합니다.
컨트롤러 코드는 그대로입니다.

```ts
import { createApp } from 'routeflow-api'
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'

const app = createApp({
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL! }),
  port: 3000,
})
```

어댑터 종류별 설명은 [`adapters.md`](./adapters.md)를 참고하세요.

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

## 다음 문서

- 서버 API 상세: [`server.md`](./server.md)
- 클라이언트 API 상세: [`client.md`](./client.md)
- 어댑터 연결 방식: [`adapters.md`](./adapters.md)
