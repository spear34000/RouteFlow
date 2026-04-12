# RouteFlow 사용 가이드

## 아키텍처: 정보는 어디에 저장되나

RouteFlow에서 정보는 **3계층**에 분산되어 저장됩니다:

```
┌─────────────────────────────────────────────────────────┐
│  1. 클라이언트 (브라우저/앱)                              │
│     - 구독 상태 (WebSocket/SSE 연결)                      │
│     - 캐시된 데이터 (메모리)                              │
└─────────────────────────────────────────────────────────┘
                           ↕
┌─────────────────────────────────────────────────────────┐
│  2. RouteFlow 서버 (Node.js)                            │
│     - 구독자 목록 (경로 → 클라이언트 매핑)                │
│     - @Reactive 엔드포인트 캐시                         │
│     - 변경 이벤트 버퍼                                    │
└─────────────────────────────────────────────────────────┘
                           ↕
┌─────────────────────────────────────────────────────────┐
│  3. 데이터베이스 (영구 저장소)                             │
│     - 실제 비즈니스 데이터                               │
│     - 변경 로그/CDC (Postgres LISTEN/NOTIFY 등)          │
└─────────────────────────────────────────────────────────┘
```

### 저장 위치별 상세

| 저장 위치 | 데이터 | 생명주기 |
|----------|--------|---------|
| **클라이언트** | 구독 상태, 캐시된 item 목록 | 페이지/앱 종료 시 소멸 |
| **서버 메모리** | 구독자 세션, 엔드포인트 결과 캐시 | 서버 재시작 시 소멸 |
| **DB** | items, users 등 영구 데이터 | 영구 |

### 데이터 흐름 예시

```
1. DB INSERT → 2. Adapter 감지 → 3. 서버 emit → 4. 구독자 브로드캐스트 → 5. 클라이언트 업데이트
```

## 설치

### 기본 설치

```bash
npm install routeflow-api reflect-metadata
```

### 데이터베이스별 설치

```bash
# PostgreSQL
npm install routeflow-api pg

# MongoDB
npm install routeflow-api mongodb

# MySQL
npm install routeflow-api mysql2

# Redis
npm install routeflow-api ioredis

# DynamoDB
npm install routeflow-api @aws-sdk/client-dynamodb

# Elasticsearch
npm install routeflow-api @elastic/elasticsearch

# OpenSearch
npm install routeflow-api @opensearch-project/opensearch

# Snowflake
npm install routeflow-api snowflake-sdk

# Cassandra
npm install routeflow-api cassandra-driver
```

## TypeScript 설정

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "esModuleInterop": true
  }
}
```

## 기본 사용법

### 1. 서버 만들기

```typescript
import 'reflect-metadata'
import { createApp, MemoryAdapter, Route, Reactive } from 'routeflow-api'
import type { Context } from 'routeflow-api'

// 메모리 어댑터 (테스트/개발용)
const adapter = new MemoryAdapter()
const items: Array<{ id: number; name: string }> = []

class ItemController {
  // 일반 REST 엔드포인트
  @Route('GET', '/items')
  async listItems(_ctx: Context) {
    return items
  }

  @Route('POST', '/items')
  async createItem(ctx: Context) {
    const body = ctx.body as { name: string }
    const item = { id: items.length + 1, name: body.name }
    items.push(item)
    
    // 변경 알림 발송 → 구독자에게 자동 푸시
    adapter.emit('items', {
      operation: 'INSERT',
      newRow: item,
      oldRow: null,
    })
    
    return item
  }

  // 실시간 엔드포인트 (@Reactive 추가)
  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async listLiveItems(_ctx: Context) {
    return items
  }
}

const app = createApp({ adapter, port: 3000 })
app.register(ItemController)
await app.listen()

console.log('Server running on http://localhost:3000')
```

### 2. 클라이언트 사용하기

```typescript
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000', {
  // 자동 재연결 설정 (선택)
  reconnect: {
    maxAttempts: 5,
    initialDelayMs: 1000,
    backoffFactor: 2,
    maxDelayMs: 30000,
  },
})

// 1. 스냅샷 가져오기 (일반 REST)
const items = await client.get<Array<{ id: number; name: string }>>('/items')
console.log('Current items:', items)

// 2. 실시간 구독 시작
const unsubscribe = client.subscribe(
  '/items/live',
  (updatedItems) => {
    console.log('Items updated:', updatedItems)
  }
)

// 3. 구독 해제 (컴포넌트 언마운트 등)
unsubscribe()

// 4. 클라이언트 종료
client.destroy()
```

## 데이터베이스 어댑터 사용법

### PostgreSQL

```typescript
import { createApp, Reactive, Route } from 'routeflow-api'
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'
import type { Context } from 'routeflow-api'

const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
})

class OrderController {
  @Route('GET', '/orders')
  async getOrders(_ctx: Context) {
    // your query logic
    return orders
  }

  @Reactive({ watch: 'orders' })
  @Route('GET', '/orders/live')
  async getLiveOrders(_ctx: Context) {
    return orders
  }
}

const app = createApp({ adapter, port: 3000 })
app.register(OrderController)
await app.listen()
```

### MongoDB

```typescript
import { MongoDbAdapter } from 'routeflow-api/adapters/mongodb'

const adapter = new MongoDbAdapter({
  connectionString: process.env.MONGODB_URL,
  database: 'myapp',
})

const app = createApp({ adapter, port: 3000 })
```

### PollingAdapter (기타 DB)

공식 어댑터가 없는 DB는 PollingAdapter로 직접 구현:

```typescript
import { createApp, PollingAdapter } from 'routeflow-api'

const adapter = new PollingAdapter<string>({
  intervalMs: 1000,
  async readChanges({ table, cursor }) {
    const rows = await db.query(`
      SELECT * FROM change_log 
      WHERE table_name = $1 AND id > $2
      ORDER BY id
    `, [table, cursor || 0])

    return {
      cursor: rows.at(-1)?.id ?? cursor,
      events: rows.map((row) => ({
        operation: row.operation,
        newRow: row.new_data,
        oldRow: row.old_data,
      })),
    }
  },
})

const app = createApp({ adapter, port: 3000 })
```

## 고급 사용법

### @Reactive 필터링

특정 사용자의 데이터만 구독:

```typescript
class UserController {
  @Reactive({
    watch: 'orders',
    filter: (event, ctx) => {
      const row = event.newRow as { userId: string } | null
      return row?.userId === ctx.params.userId
    },
  })
  @Route('GET', '/users/:userId/orders/live')
  async getUserOrders(ctx: Context) {
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
  }
}
```

### SSE 전송 방식

```typescript
// 서버
const app = createApp({
  adapter,
  transport: 'sse',  // 'websocket' 대신 'sse'
  port: 3000,
})

// 클라이언트 (동일하게 사용)
const client = createClient('http://localhost:3000', {
  transport: 'sse',
})
```

### 에러 처리

```typescript
import { ReactiveClientError } from 'routeflow-api/client'

try {
  await client.get('/protected')
} catch (error) {
  if (error instanceof ReactiveClientError) {
    console.log('Status:', error.status)
    console.log('Code:', error.code)
  }
}
```

### HTTP 메서드

```typescript
await client.get('/items')
await client.post('/items', { name: 'Apple' })
await client.put('/items/1', { name: 'Orange' })
await client.patch('/items/1', { archived: true })
await client.del('/items/1')
```

## 프레임워크별 클라이언트 사용법

### React

```tsx
import { useEffect, useState } from 'react'
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

function ItemList() {
  const [items, setItems] = useState<Array<{ id: number; name: string }>>([])

  useEffect(() => {
    // 초기 데이터 로드
    client.get('/items').then(setItems)

    // 실시간 구독
    const unsubscribe = client.subscribe('/items/live', setItems)

    return () => {
      unsubscribe()
    }
  }, [])

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  )
}
```

### Vue

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')
const items = ref([])
let unsubscribe

onMounted(async () => {
  items.value = await client.get('/items')
  unsubscribe = client.subscribe('/items/live', (data) => {
    items.value = data
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>
```

### Svelte

```svelte
<script>
import { createClient } from 'routeflow-api/client'
import { onMount, onDestroy } from 'svelte'

const client = createClient('http://localhost:3000')
let items = []
let unsubscribe

onMount(async () => {
  items = await client.get('/items')
  unsubscribe = client.subscribe('/items/live', (data) => {
    items = data
  })
})

onDestroy(() => {
  unsubscribe?.()
})
</script>

<ul>
  {#each items as item}
    <li>{item.name}</li>
  {/each}
</ul>
```

## 팁과 모범 사례

### 1. 첫 화면은 항상 스냅샷으로

```typescript
// Good: 스냅샷 먼저, 그 다음 구독
const items = await client.get('/items')
render(items)

const unsubscribe = client.subscribe('/items/live', render)
```

### 2. 메모리 관리

```typescript
// 컴포넌트/페이지 종료 시 반드시 구독 해제
return () => {
  unsubscribe()
  // 또는 전체 클라이언트 종료
  // client.destroy()
}
```

### 3. 에러 복구

```typescript
const client = createClient('http://localhost:3000', {
  reconnect: {
    maxAttempts: 10,
    initialDelayMs: 500,
    backoffFactor: 2,
    maxDelayMs: 30000,
  },
  onError: (error) => {
    console.error('Connection error:', error)
    // 사용자에게 알림 표시
  },
})
```

### 4. 인증 헤더

```typescript
const client = createClient('http://localhost:3000', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
})
```

### 5. 어댑터 선택 가이드

| 상황 | 추천 어댑터 |
|------|------------|
| 빠른 테스트/프로토타입 | `MemoryAdapter` |
| PostgreSQL 프로덕션 | `PostgresAdapter` |
| MongoDB 프로덕션 | `MongoDbAdapter` |
| 기타 DB | `PollingAdapter`로 직접 구현 |

## 문제 해결

### WebSocket 연결 실패

```typescript
// SSE로 폴백
const client = createClient('http://localhost:3000', {
  transport: 'sse',
})
```

### 타입 에러

```typescript
// reflect-metadata import 확인
import 'reflect-metadata'  // 서버 코드 최상단

// tsconfig.json 설정 확인
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true
}
```

### 변경 이벤트 안 옴

1. 어댑터 연결 확인
2. 테이블명 일치 확인 (`watch: 'items'`)
3. 어댑터에 emit 호출 확인

## 참고 자료

- [API 문서](./server.md)
- [클라이언트 문서](./client.md)
- [어댑터 문서](./adapters.md)
- [시작하기](./getting-started.md)
