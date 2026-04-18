# Server Guide

RouteFlow 서버 코드는 `createApp()`으로 앱을 만들고, 컨트롤러 메서드에 `@Route`와 `@Reactive`를 붙이는 방식으로 작성합니다.

이 문서는 "서버에서 RouteFlow를 어떻게 조립하는가"에 집중합니다.

- 왜 이 구조가 필요한지 먼저 보려면 [`why-routeflow.md`](./why-routeflow.md)
- 실제 설계 패턴이 궁금하면 [`usage-guide.md`](./usage-guide.md)
- 가장 짧은 시작 예제는 [`getting-started.md`](./getting-started.md)

## 서버에서 쉽게 풀리는 문제

보통 서버에서 실시간 기능을 붙일 때는 다음이 번거롭습니다.

- HTTP route와 WebSocket 채널을 따로 설계해야 한다
- 특정 사용자나 room 범위만 받도록 fan-out을 다시 나눠야 한다
- query나 include가 붙은 응답을 live하게 유지하려면 별도 로직이 필요하다

RouteFlow 서버는 이 문제를 route 중심으로 푼다는 점이 핵심입니다.

- `@Route`는 평범한 HTTP endpoint를 만든다
- `@Reactive`는 그 endpoint를 live하게 만든다
- `app.flow()`는 query-aware live, smart delta, live include 같은 고수준 패턴을 바로 붙인다

## 기본 구조

```ts
import { createApp, MemoryAdapter, Reactive, Route } from 'routeflow-api'
import type { Context } from 'routeflow-api'

const app = createApp({
  adapter: new MemoryAdapter(),
  transport: 'websocket',
  port: 3000,
})

class OrderController {
  @Route('GET', '/orders/:userId')
  async getOrders(ctx: Context) {
    return loadOrders(ctx.params.userId)
  }

  @Reactive({
    watch: 'orders',
    filter: (event, ctx) => {
      const row = event.newRow as { user_id: string } | null
      return row?.user_id === ctx.params.userId
    },
  })
  @Route('GET', '/orders/:userId/live')
  async getLiveOrders(ctx: Context) {
    return loadOrders(ctx.params.userId)
  }
}

app.register(OrderController)
await app.listen()
```

## `createApp()`

```ts
const app = createApp({
  adapter,
  transport: 'websocket',
  port: 3000,
})
```

옵션:

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `adapter` | `DatabaseAdapter` | 필수 | RouteFlow DB 어댑터 |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | 실시간 전송 방식 |
| `port` | `number` | `3000` | 서버 리슨 포트 |

`createApp()`으로 만든 앱은 `GET /_health`를 자동 등록하고, 모든 HTTP 요청에 `X-Request-ID`를 생성 또는 전달합니다.

## `@Route(method, path)`

일반 HTTP 엔드포인트를 등록합니다.

```ts
@Route('GET', '/items/:id')
async getItem(ctx: Context) {
  return findItem(ctx.params.id)
}
```

지원하는 흐름:

- 경로 파라미터 `:id`
- 쿼리 파라미터 `ctx.query`
- 요청 바디 `ctx.body`
- 요청 헤더 `ctx.headers`
- 요청 추적 ID `ctx.requestId`

즉, 먼저 REST route를 만들고 그다음 live를 붙이는 흐름이 기본입니다.

## `@Reactive(options)`

live 엔드포인트에 붙입니다. DB 변경 이벤트가 들어오면, RouteFlow가 핸들러를 다시 실행해서 최신 결과를 구독자에게 푸시합니다.

```ts
@Reactive({
  watch: 'items',
  debounce: 100,
  filter: (event, ctx) => {
    const row = event.newRow as { ownerId: string } | null
    return row?.ownerId === ctx.params.userId
  },
})
@Route('GET', '/users/:userId/items/live')
async getUserItems(ctx: Context) {
  return findItemsByUser(ctx.params.userId)
}
```

옵션:

| 옵션 | 타입 | 설명 |
|---|---|---|
| `watch` | `string \| string[]` | 감시할 테이블 또는 컬렉션 이름 |
| `filter` | `(event, ctx) => boolean` | 해당 변경이 특정 구독자에게 영향이 있는지 판별 |
| `debounce` | `number` | 재계산 디바운스 시간(ms) |

잘 맞는 경우:

- 사용자별로 다른 결과를 돌려줄 때
- 같은 테이블이어도 특정 room/project 구독자만 영향받아야 할 때
- route 결과를 다시 계산하는 편이 이벤트 payload를 직접 설계하는 것보다 쉬울 때

## `app.register(Controller)`

컨트롤러 클래스를 등록합니다. `@Route`와 `@Reactive`가 붙은 메서드를 자동 스캔해서 Fastify 라우트와 reactive 엔드포인트를 등록합니다.

```ts
app.register(ItemController)
app.register(OrderController)  // 여러 컨트롤러 체이닝 가능
```

## `app.flow()`에서 많이 쓰는 차별화 옵션

RouteFlow를 단순 "live REST"보다 강하게 만드는 옵션은 아래 셋입니다.

```ts
app.flow('/rooms/:roomId/messages', messages, {
  push: 'smart',
  queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
  query: 'auto',
  relations: {
    author: { store: users, foreignKey: 'authorId', watch: 'users' },
  },
  liveInclude: true,
})
```

- `push: 'smart'`
  안전하면 delta, 아니면 snapshot으로 자동 fallback 합니다.
- `queryFilter` + `query: 'auto'`
  room id, `limit`, `after`, `order` 같은 결과 shape 차이를 live subscription 그룹에 반영합니다.
- `relations` + `liveInclude: true`
  `?include=author` 같은 응답을 live로 유지하고, author 변경도 다시 계산합니다.

relation alias와 실제 변경 소스 이름이 다를 때:

```ts
relations: {
  author: { store: users, foreignKey: 'authorId', watch: 'users' },
}
```

`watch`는 relation store의 실제 변경 이벤트 이름을 명시할 때 씁니다.

이 조합은 특히 아래 문제를 줄이는 데 강합니다.

- `?limit`, `?after`, `?order`가 붙는 live 목록 응답
- room/team/project 범위가 path param으로 결정되는 응답
- `?include=author`처럼 relation이 붙은 응답
- append형 route에서 delta push를 쓰고 싶지만, unsafe한 경우 fallback도 필요할 때

## `app.getFastify()`

내부 Fastify 인스턴스를 직접 다룰 수 있습니다. 헬스체크, 정적 파일, 커스텀 미들웨어 추가 시 사용합니다.

```ts
const fastify = app.getFastify()

fastify.get('/health', async () => ({ status: 'ok' }))
```

## `app.listen(port?)`

어댑터 연결 → 전송 레이어 초기화 → 서버 시작 순서로 실행됩니다. 서버가 뜨면 `.routeflow/info.json`이 자동 생성됩니다.

```ts
await app.listen()         // AppOptions의 port 사용
await app.listen(8080)     // 포트 재정의
```

## `app.close()`

서버를 종료하고 어댑터 연결을 해제합니다.

```ts
await app.close()
```

`app.listen()`으로 시작한 프로세스는 기본적으로 `SIGTERM`, `SIGINT`를 잡아 graceful shutdown을 수행합니다. 컨테이너 환경에서는 최대 10초 동안 in-flight 작업을 정리한 뒤 종료합니다.

## 기본 운영 엔드포인트

### `GET /_health`

별도 등록 없이 아래 헬스체크가 제공됩니다.

```json
{
  "status": "ok",
  "uptime": 123,
  "timestamp": "2026-04-17T00:00:00.000Z"
}
```

### `ctx.requestId` / `X-Request-ID`

RouteFlow는 각 HTTP 요청마다 request id를 보장합니다.

- `X-Request-ID` 헤더가 들어오면 그대로 사용
- 없으면 서버가 새 ID를 생성
- 응답 헤더에도 같은 값을 기록
- 미들웨어와 핸들러에서는 `ctx.requestId`로 접근

```ts
app.use(async (ctx, next) => {
  console.log(`[${ctx.requestId}] ${ctx.params.userId ?? 'anonymous'}`)
  await next()
})
```

## `.routeflow/info.json`

`app.listen()` 완료 시 프로젝트 루트에 자동 생성됩니다.

```json
{
  "port": 3000,
  "transport": "websocket",
  "adapter": "MemoryAdapter",
  "routes": [
    { "method": "GET",  "path": "/items",      "reactive": false },
    { "method": "POST", "path": "/items",      "reactive": false },
    { "method": "GET",  "path": "/items/live", "reactive": true  }
  ],
  "startedAt": "2026-04-12T14:00:00.000Z"
}
```

## 언제 `filter`를 써야 하나

아래 경우에는 `filter`를 넣는 편이 맞습니다.

- 사용자별 데이터가 다를 때
- 같은 테이블이어도 일부 구독자만 영향을 받아야 할 때
- 권한 범위를 구독 단계에서 한 번 더 좁혀야 할 때

반대로 모든 구독자가 같은 결과를 받는 단순 route라면 `watch`만으로 충분한 경우가 많습니다.

## 전송 방식

기본은 WebSocket입니다.

```ts
createApp({ adapter, transport: 'websocket', port: 3000 })
```

SSE로 바꿀 수도 있습니다.

```ts
createApp({ adapter, transport: 'sse', port: 3000 })
```

핸들러 작성 방식은 동일하고, 전송 레이어만 바뀝니다.

## `TableStore<T>` 패턴

컨트롤러에 스토어를 주입할 때 `TableStore<T>` 인터페이스를 쓰면 SQLite, Postgres 등 어떤 백엔드든 같은 팩토리를 재사용할 수 있습니다.

```ts
import type { TableStore } from 'routeflow-api'

interface Order { id: number; userId: string; total: number }

function createOrderController(orders: TableStore<Order>) {
  class OrderController {
    @Route('GET', '/orders')
    async list(_ctx: Context) { return orders.list() }

    @Route('POST', '/orders')
    async create(ctx: Context) {
      return orders.create(ctx.body as Omit<Order, 'id'>)
    }

    @Reactive({ watch: 'orders' })
    @Route('GET', '/orders/live')
    async live(_ctx: Context) { return orders.list() }
  }
  return OrderController
}

// SQLite
import { RouteStore } from 'routeflow-api/sqlite'
const db     = new RouteStore('./data/app.db')
const orders = db.table('orders', { userId: 'text', total: 'real' })
createApp({ adapter: db }).register(createOrderController(orders))

// 다른 DB — 같은 팩토리
createApp({ adapter: myAdapter }).register(createOrderController(myOrderStore))
```

`RouteStore`의 `create()` · `update()` · `delete()`는 자동으로 `ChangeEvent`를 발생시켜 `@Reactive` 구독자에게 push됩니다. 다른 DB 어댑터는 CDC(트리거, binlog 등)가 이 역할을 담당합니다.

## 추천 패턴

- 일반 REST 엔드포인트와 live 엔드포인트를 같은 컨트롤러에 둔다.
- live 엔드포인트는 일반 엔드포인트와 같은 조회 함수를 재사용한다.
- 컨트롤러 팩토리는 `TableStore<T>`를 받도록 작성해 백엔드 교체를 쉽게 한다.
- DB 이벤트는 가능한 한 도메인 단위로 `watch` 이름을 맞춘다.
- 권한이나 사용자 범위가 있으면 `filter`로 좁힌다.
