# Getting Started

RouteFlow는 기존 REST API처럼 라우트를 만들고, live 엔드포인트에만 `@Reactive`를 붙이는 방식으로 사용합니다.

이 프로젝트가 왜 필요한지부터 보고 싶다면 [`why-routeflow.md`](./why-routeflow.md)를 먼저 읽어도 좋습니다.

핵심 메시지는 이 한 줄입니다.

- REST처럼 만든다.
- 쿼리와 관계까지 이해하는 live 엔드포인트를 붙인다.
- 바뀐 것만 정확히 다시 밀어준다.

이 문서는 "처음 설치한 사람" 기준으로 작성했습니다.

- 가장 빠른 검증: `Todo` 예제 실행
- 차별점 확인: `Differentiation` 예제 실행
- 가장 짧은 코드 이해: SQLite `RouteStore`
- 그다음 확장: 실제 DB 어댑터 교체

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

## 1-1. 제일 먼저 해볼 것

코드부터 읽기 전에 예제를 한 번 띄워보는 편이 이해가 빠릅니다.

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

자동 smoke test:

```bash
pnpm run example:todos:smoke
```

이 단계에서 확인해야 하는 것:

- REST `GET /todos`가 동작한다.
- REST `POST /todos`가 동작한다.
- `GET /todos/live`를 구독한 클라이언트가 자동 push를 받는다.
- `/_docs`, `/_health`가 바로 열린다.

차별화 기능까지 바로 보고 싶다면:

```bash
pnpm run example:differentiation
pnpm run example:differentiation:smoke
```

이 예제는 `push: 'smart'`, room-scoped query-aware live, `liveInclude`를 함께 보여줍니다.

---

## 2. 서버 만들기

아래 예제는 “직접 서버 코드를 쓰는 최소 형태”입니다.

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

보통은 아래 순서로 씁니다.

1. `get()`으로 초기 화면 데이터를 가져온다.
2. 같은 자원에 대해 `/live`를 `subscribe()` 한다.
3. 서버에서 DB가 바뀌면 최신 결과를 자동으로 받는다.

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

## 6. 처음 도입할 때 체크리스트

- Node 버전이 SQLite 요구사항 이상인지 확인
- `@Route`, `@Reactive`가 붙은 엔드포인트가 구분되어 있는지 확인
- 브라우저/Node 클라이언트에서 `get()` 다음 `subscribe()` 흐름이 맞는지 확인
- `.routeflow/`를 ignore 했는지 확인
- 운영 환경이면 `/_health`, `X-Request-ID`, graceful shutdown 동작을 확인

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
- 실행 예제 모음: [`examples.md`](./examples.md)
