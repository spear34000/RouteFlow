# Getting Started

RouteFlow는 기존 REST API처럼 라우트를 만들고, live 엔드포인트에만 `@Reactive`를 붙이는 방식으로 사용합니다.

## 1. 설치

```bash
pnpm add @routeflow/core @routeflow/client reflect-metadata
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

## 2. 서버 만들기

```ts
import 'reflect-metadata'
import { createApp, MemoryAdapter, Reactive, Route } from '@routeflow/core'
import type { Context } from '@routeflow/core'

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

items.push({ id: 2, name: 'Orange' })
adapter.emit('items', {
  operation: 'INSERT',
  newRow: { id: 2, name: 'Orange' },
  oldRow: null,
})
```

핵심은 이겁니다.

- `/items`는 일반 REST 엔드포인트
- `/items/live`는 구독 가능한 live 엔드포인트
- DB 변경 이벤트가 들어오면 RouteFlow가 핸들러를 다시 실행하고 최신 결과를 푸시

## 3. 클라이언트에서 구독하기

```ts
import { createClient } from '@routeflow/client'

const client = createClient('http://localhost:3000')

const snapshot = await client.get('/items')
console.log(snapshot)

const unsubscribe = client.subscribe('/items/live', (nextItems) => {
  console.log('live update', nextItems)
})

// 필요 시 해제
unsubscribe()
```

클라이언트는 WebSocket 메시지 포맷이나 채널 이름을 알 필요가 없습니다. 경로만 구독하면 됩니다.

## 4. 전송 방식 바꾸기

서버:

```ts
createApp({
  adapter,
  transport: 'sse',
  port: 3000,
})
```

클라이언트:

```ts
createClient('http://localhost:3000', { transport: 'sse' })
```

사용자 코드에서는 `subscribe()` 호출 방식이 그대로 유지됩니다.

## 5. 실제 DB로 바꾸기

MemoryAdapter 대신 공식 어댑터를 연결하면 됩니다.

```ts
import { createApp } from '@routeflow/core'
import { PostgresAdapter } from '@routeflow/adapter-postgres'

const app = createApp({
  adapter: new PostgresAdapter({
    connectionString: process.env.ROUTEFLOW_POSTGRES_URL!,
  }),
  port: 3000,
})
```

핸들러 코드와 클라이언트 구독 방식은 그대로 두고, 어댑터만 교체하는 것이 기본 흐름입니다.

## 다음 문서

- 서버 API 상세: [`server.md`](./server.md)
- 클라이언트 API 상세: [`client.md`](./client.md)
- 어댑터 연결 방식: [`adapters.md`](./adapters.md)
