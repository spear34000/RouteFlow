# @routeflow/core

RouteFlow 프레임워크 코어.

## 설치

```bash
pnpm add @routeflow/core reflect-metadata
```

`tsconfig.json`에 반드시 추가:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## 기본 사용법

```typescript
import 'reflect-metadata'
import { createApp, Reactive, Route } from '@routeflow/core'
import { MemoryAdapter } from '@routeflow/core/adapters'
import type { Context } from '@routeflow/core'

const adapter = new MemoryAdapter()

class OrderController {
  // 일반 REST
  @Route('GET', '/orders/:userId')
  async getOrders(ctx: Context) {
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
  }

  // 반응형 — DB 변경 시 구독 클라이언트에 자동 푸시
  @Reactive({
    watch: 'orders',
    filter: (event, ctx) => {
      const row = event.newRow as { user_id: string } | null
      return row?.user_id === ctx.params.userId
    },
  })
  @Route('GET', '/orders/:userId/live')
  async getLiveOrders(ctx: Context) {
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
  }
}

const app = createApp({ adapter, port: 3000 })
app.register(OrderController)
await app.listen()
```

## Transport

| 옵션 | 설명 |
|---|---|
| `'websocket'` (기본) | WS 업그레이드, 양방향 |
| `'sse'` | `GET /_sse/subscribe?path=...`, 단방향, HTTP/1.1 호환 |

```typescript
createApp({ adapter, transport: 'sse', port: 3000 })
```

## API

### `createApp(options)`

| 필드 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `adapter` | `DatabaseAdapter` | — | DB 어댑터 인스턴스 |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | 실시간 전송 방식 |
| `port` | `number` | `3000` | 리슨 포트 |

### `@Route(method, path)`

메서드를 HTTP 엔드포인트로 등록. Fastify 스타일 경로 파라미터(`:param`) 지원.

### `@Reactive(options)`

`@Route`와 함께 사용. DB 변경 시 핸들러를 재실행하여 결과를 구독자에게 푸시.

| 필드 | 타입 | 설명 |
|---|---|---|
| `watch` | `string \| string[]` | 감시할 테이블명 |
| `filter` | `(event, ctx) => boolean` | 구독자별 필터 함수 |
| `debounce` | `number` | 디바운스 ms |

### `MemoryAdapter`

DB 없이 테스트/개발용. `emit(table, event)`로 변경 이벤트를 수동 발생.

### `PollingAdapter`

네이티브 RouteFlow 어댑터가 아직 없는 DB를 연결할 때 사용하는 범용 어댑터.

```typescript
import { PollingAdapter } from '@routeflow/core/adapters'

const adapter = new PollingAdapter<string>({
  intervalMs: 1_000,
  async readChanges({ table, cursor }) {
    const changes = await fetchChangeFeed(table, cursor)
    return {
      cursor: changes.at(-1)?.cursor ?? cursor,
      events: changes.map((change) => ({
        operation: change.operation,
        newRow: change.newRow,
        oldRow: change.oldRow,
      })),
    }
  },
})
```

### 지원 매트릭스

`@routeflow/core`에서 바로 조회 가능:

```typescript
import {
  SUPPORTED_DATABASES,
  getDatabaseSupport,
  listOfficialDatabases,
} from '@routeflow/core'

console.log(SUPPORTED_DATABASES.length) // 28
console.log(listOfficialDatabases().map((db) => db.name))
console.log(getDatabaseSupport('MongoDB'))
```

### 공식 지원

| DB | tier | 대표 연결 방식 |
|---|---|---|
| PostgreSQL | `official` | native adapter |
| MySQL | `official` | native adapter |
| MongoDB | `official` | native adapter |
| Redis | `official` | native adapter |
| DynamoDB | `official` | native adapter |
| Elasticsearch | `official` | native adapter |
| OpenSearch | `official` | native adapter |
| Snowflake | `official` | native adapter |

공식 지원 DB:

- PostgreSQL, MySQL, MongoDB, Redis
- DynamoDB
- Elasticsearch, OpenSearch
- Snowflake

그 외 등록된 DB는 실험적/보류 상태로 매트릭스에만 남아 있습니다.
