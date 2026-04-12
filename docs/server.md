# Server Guide

RouteFlow 서버 코드는 `createApp()`으로 앱을 만들고, 컨트롤러 메서드에 `@Route`와 `@Reactive`를 붙이는 방식으로 작성합니다.

## 기본 구조

```ts
import 'reflect-metadata'
import { createApp, MemoryAdapter, Reactive, Route } from '@spear340000/core'
import type { Context } from '@spear340000/core'

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

- `adapter`: RouteFlow DB 어댑터
- `transport`: `'websocket'` 또는 `'sse'`
- `port`: 서버 리슨 포트

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
- 일반 REST 응답
- live 엔드포인트의 스냅샷 계산 함수

## `@Reactive(options)`

live 엔드포인트에 붙입니다. DB 변경 이벤트가 들어오면, RouteFlow가 핸들러를 다시 실행해서 최신 결과를 푸시합니다.

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

- `watch`: 감시할 테이블 또는 컬렉션 이름
- `filter`: 해당 변경이 특정 구독자에게 영향이 있는지 판별
- `debounce`: 재계산 디바운스 시간

## 언제 `filter`를 써야 하나

아래 경우에는 `filter`를 넣는 편이 맞습니다.

- 사용자별 데이터가 다를 때
- 같은 테이블이어도 일부 구독자만 영향을 받아야 할 때
- 권한 범위를 구독 단계에서 한 번 더 좁혀야 할 때

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

## 추천 패턴

- 일반 REST 엔드포인트와 live 엔드포인트를 같은 컨트롤러에 둔다.
- live 엔드포인트는 일반 엔드포인트와 같은 조회 함수를 재사용한다.
- DB 이벤트는 가능한 한 도메인 단위로 `watch` 이름을 맞춘다.
- 권한이나 사용자 범위가 있으면 `filter`로 좁힌다.
