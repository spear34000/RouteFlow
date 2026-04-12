# @routeflow/client

RouteFlow 브라우저/Node.js 클라이언트 SDK.

핵심 목적은 기존 REST 호출 방식은 유지하면서, live 엔드포인트는 `subscribe()`만으로 구독하게 만드는 것입니다.

## 설치

```bash
pnpm add @routeflow/client
```

## 사용법

```typescript
import { createClient } from '@routeflow/client'

const client = createClient('http://localhost:3000')

// 일반 REST 요청
const orders = await client.get<Order[]>('/orders/123')
const created = await client.post<Order>('/orders', { item: 'book', qty: 1 })
await client.del('/orders/99')

// live 엔드포인트 구독
const unsubscribe = client.subscribe<Order[]>('/orders/123/live', (data) => {
  console.log('업데이트:', data)
})

// 구독 해제
unsubscribe()

// 클라이언트 종료 (컴포넌트 언마운트 등)
client.destroy()
```

일반 요청과 실시간 구독을 서로 다른 프로토콜/SDK로 나누지 않고, 같은 클라이언트에서 처리하는 것이 이 패키지의 역할입니다.

## SSE 모드

```typescript
const client = createClient('http://localhost:3000', { transport: 'sse' })

// 이후 subscribe() 호출은 EventSource를 사용
client.subscribe('/items/live', (data) => console.log(data))
```

## 옵션

```typescript
createClient('http://localhost:3000', {
  // 'websocket' (기본) 또는 'sse'
  transport: 'websocket',

  // 모든 HTTP 요청에 추가되는 헤더
  headers: { Authorization: 'Bearer token' },

  // 실시간 연결 재시도 설정
  reconnect: {
    maxAttempts: 10,      // 0 = 무제한 (기본)
    initialDelayMs: 500,  // 첫 재시도 대기 ms
    backoffFactor: 2,     // 지수 증가 배수
    maxDelayMs: 30_000,   // 최대 대기 ms
  },

  // 서버에서 에러 메시지가 왔을 때 호출
  onError: (err) => console.error(err.code, err.message),
})
```

## HTTP 메서드

| 메서드 | 설명 |
|---|---|
| `client.get<T>(path, query?, headers?)` | GET 요청 |
| `client.post<T>(path, body?, headers?)` | POST 요청 |
| `client.put<T>(path, body?, headers?)` | PUT 요청 |
| `client.patch<T>(path, body?, headers?)` | PATCH 요청 |
| `client.del<T>(path, headers?)` | DELETE 요청 |

에러 시 `ReactiveClientError`를 throw합니다:

```typescript
import { ReactiveClientError } from '@routeflow/client'

try {
  await client.get('/missing')
} catch (err) {
  if (err instanceof ReactiveClientError) {
    console.log(err.code)   // 'HTTP_ERROR' | 'NETWORK_ERROR' | 'PARSE_ERROR'
    console.log(err.status) // HTTP 상태 코드 (있는 경우)
  }
}
```

## 브라우저 호환성

WebSocket과 Fetch API를 지원하는 모든 현대 브라우저에서 동작합니다.  
Node.js 22+ 환경에서는 기본 `WebSocket`이 내장되어 별도 설정 없이 동작합니다.  
구버전 Node.js에서는 `ws` 패키지를 `globalThis.WebSocket`에 할당하세요.
