# Client Guide

RouteFlow 클라이언트는 일반 REST 호출과 live 구독을 같은 인스턴스에서 처리합니다.

서버가 v1.0.22 이상이면 모든 HTTP 응답에 `X-Request-ID`가 포함되므로, 브라우저 네트워크 탭이나 프록시 로그와 서버 로그를 쉽게 연결할 수 있습니다.

## 설치

```bash
npm install routeflow-api
```

클라이언트는 `routeflow-api/client`에 포함되어 있습니다.

## 기본 사용법

```ts
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

const items = await client.get('/items')

const unsubscribe = client.subscribe('/items/live', (nextItems) => {
  console.log(nextItems)
})
```

핵심은 다음 두 줄입니다.

- 일반 요청: `client.get('/items')`
- live 구독: `client.subscribe('/items/live', callback)`

RouteFlow 사용자는 WebSocket 채널, 이벤트 타입, 메시지 포맷을 직접 다루지 않습니다.

## HTTP 메서드

```ts
await client.get('/items')
await client.post('/items', { name: 'Apple' })
await client.put('/items/1', { name: 'Orange' })
await client.patch('/items/1', { archived: true })
await client.del('/items/1')
```

## `subscribe()`

```ts
const unsubscribe = client.subscribe<Item[]>('/items/live', (items) => {
  render(items)
})
```

구독 해제:

```ts
unsubscribe()
```

클라이언트 전체 종료:

```ts
client.destroy()
```

## SSE 사용

```ts
const client = createClient('http://localhost:3000', {
  transport: 'sse',
})
```

이후 `subscribe()` 사용 방식은 동일합니다.

## 공통 옵션

```ts
const client = createClient('http://localhost:3000', {
  transport: 'websocket',        // 'websocket' | 'sse'
  headers: {
    Authorization: 'Bearer token',
  },
  reconnect: {
    maxAttempts: 10,
    initialDelayMs: 500,
    backoffFactor: 2,
    maxDelayMs: 30_000,
  },
  onError: (error) => {
    console.error(error)
  },
})
```

## 에러 처리

```ts
import { ReactiveClientError } from 'routeflow-api/client'

try {
  await client.get('/missing')
} catch (error) {
  if (error instanceof ReactiveClientError) {
    console.log(error.code)
    console.log(error.status)
  }
}
```

## 추천 패턴

- 첫 화면은 `get()`으로 스냅샷을 가져온다.
- 그다음 같은 자원에 대한 `/live` 경로를 `subscribe()` 한다.
- 화면이 사라질 때 `unsubscribe()` 또는 `client.destroy()`를 호출한다.
- 재연결은 프레임워크가 자동 처리하므로 별도 구현 불필요.
