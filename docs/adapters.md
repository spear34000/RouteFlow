# Adapter Guide

RouteFlow는 어댑터를 바꿔도 컨트롤러 코드를 유지하는 것을 목표로 합니다.

---

## 어댑터 선택 기준

| 상황 | 추천 |
|---|---|
| 데모, 테스트, 학습 | `MemoryAdapter` |
| 로컬 개발 / 파일 기반 영구 저장 | `RouteStore` (SQLite 내장) |
| PostgreSQL 기반 실서비스 | `PostgresAdapter` |
| 공식 지원 DB | 해당 네이티브 어댑터 |
| 비공식 DB 또는 사내 저장소 | `PollingAdapter` |

---

## 개발 패턴

모든 백엔드에서 컨트롤러 코드는 동일합니다. 바뀌는 것은 스토어와 어댑터 연결뿐입니다.

```ts
// 컨트롤러는 TableStore<T> 인터페이스만 봄 — 어떤 백엔드든 상관없음
function createItemController(items: TableStore<Item>) {
  class ItemController {
    @Route('POST', '/items')
    async createItem(ctx: Context) {
      return items.create({ name: ctx.body.name, createdAt: new Date().toISOString() })
    }

    @Reactive({ watch: 'items' })
    @Route('GET', '/items/live')
    async listLive(_ctx: Context) { return items.list() }
  }
  return ItemController
}

// SQLite
const db    = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })
createApp({ adapter: db, port: 3000 })

// Postgres (동일한 팩토리, 다른 연결)
const store   = new PostgresItemStore(pool)      // TableStore<Item> 구현
const adapter = new PostgresAdapter({ connectionString })
createApp({ adapter, port: 3000 })
```

---

## `MemoryAdapter`

테스트, 문서 예제, 로컬 프로토타입에 가장 간단합니다.

```ts
import { createApp, MemoryAdapter } from 'routeflow-api'

const adapter = new MemoryAdapter()
const app = createApp({ adapter, port: 3000 })
```

변경 이벤트는 수동으로 발생시킵니다.

```ts
adapter.emit('items', {
  operation: 'INSERT',
  newRow: { id: 2, name: 'Orange' },
  oldRow: null,
})
```

> 데이터는 프로세스 메모리에만 존재합니다. 서버 재시작 시 초기화됩니다.

---

## `RouteStore` (SQLite, 파일 저장)

**로컬 개발 또는 단일 서버 운영**에 권장합니다.

`RouteStore`는 `DatabaseAdapter`와 테이블 CRUD를 하나로 통합합니다.
Node.js 22.13+ 내장 `node:sqlite`를 사용하므로 추가 패키지가 없습니다.

권장 런타임:

- 2026-04-17 기준 최신 LTS `Node.js 24.15.0 (LTS)`
- CommonJS 프로젝트에서도 `require('routeflow-api/sqlite')` 사용 가능

```ts
import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'

const db    = new RouteStore('./data/app.db')
const items = db.table('items', {
  name:      'text',
  createdAt: 'text',
})

await items.seed([{ name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' }])

// db 자체가 어댑터
const app = createApp({ adapter: db, port: 3000 })
```

```js
const { RouteStore } = require('routeflow-api/sqlite')
```

`create()`, `update()`, `delete()` 호출 시 변경 이벤트가 자동으로 발생해 `@Reactive` 엔드포인트가 즉시 push됩니다.

v1.0.22부터는 테이블별 64개 LRU statement cache가 적용되어 반복 CRUD 쿼리의 parse/compile 비용을 줄입니다.

### 컬럼 타입

| 타입 | TypeScript | 용도 |
|---|---|---|
| `'text'` | `string` | 문자열 |
| `'integer'` | `number` | 정수 |
| `'real'` | `number` | 소수 |
| `'json'` | `unknown` | 객체/배열 (자동 직렬화) |

### 테이블 메서드

```ts
items.list()                          // 전체 조회
items.list({ where: { name: 'A' }, orderBy: 'id', order: 'desc', limit: 10 })
items.get(id)                         // 단건 조회
items.create({ name, createdAt })     // 생성 + 자동 이벤트
items.update(id, { name })            // 수정 + 자동 이벤트
items.delete(id)                      // 삭제 + 자동 이벤트
items.seed([...])                     // 비어있을 때만 초기 데이터 삽입
```

---

## PostgreSQL

```ts
import { createApp } from 'routeflow-api'
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'

const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL!,
})
const app = createApp({ adapter, port: 3000 })
```

내부적으로 `LISTEN/NOTIFY` + 트리거를 사용합니다.  
데이터 접근은 `pg`, `prisma`, `drizzle` 등 원하는 방식으로 구현하고, `TableStore<T>` 인터페이스를 구현합니다.

```ts
import type { TableStore } from 'routeflow-api'

class ItemStore implements TableStore<Item> {
  async list()              { /* pg query */ }
  async get(id)             { /* pg query */ }
  async create(data)        { /* pg query — Postgres 트리거가 이벤트를 자동 발생 */ }
  async update(id, data)    { /* pg query */ }
  async delete(id)          { /* pg query */ }
}
```

---

## 네이티브 공식 어댑터 전체 목록

| 어댑터 | import 경로 | 추가 패키지 | 변경 감지 방식 |
|---|---|---|---|
| PostgreSQL | `routeflow-api/adapters/postgres` | `pg` | LISTEN/NOTIFY + 트리거 |
| MySQL | `routeflow-api/adapters/mysql` | `mysql2` | binlog |
| MongoDB | `routeflow-api/adapters/mongodb` | `mongodb` | Change Streams |
| Redis | `routeflow-api/adapters/redis` | `ioredis` | Pub/Sub |
| DynamoDB | `routeflow-api/adapters/dynamodb` | `@aws-sdk/client-dynamodb` | Streams |
| Elasticsearch | `routeflow-api/adapters/elasticsearch` | `@elastic/elasticsearch` | 외부 변경 소스 |
| OpenSearch | `routeflow-api/adapters/opensearch` | `@opensearch-project/opensearch` | 외부 변경 소스 |
| Snowflake | `routeflow-api/adapters/snowflake` | `snowflake-sdk@^2.0.4` | stream/task |

```bash
npm install routeflow-api pg        # PostgreSQL
npm install routeflow-api mongodb   # MongoDB
```

---

## `PollingAdapter` (네이티브 어댑터가 없을 때)

공식 네이티브 어댑터가 없는 DB는 `PollingAdapter`로 연결할 수 있습니다.

```ts
import { createApp, PollingAdapter } from 'routeflow-api'

const adapter = new PollingAdapter<string>({
  intervalMs: 1000,
  async readChanges({ table, cursor }) {
    const rows = await loadChangesFromYourDatabase(table, cursor)
    return {
      cursor: rows.at(-1)?.cursor ?? cursor,
      events: rows.map((row) => ({
        operation: row.operation,
        newRow: row.newRow,
        oldRow: row.oldRow,
      })),
    }
  },
})

createApp({ adapter, port: 3000 })
```

다음 경우에 적합합니다.

- 해당 DB용 공식 RouteFlow 어댑터가 없을 때
- CDC 대신 폴링으로도 충분할 때
- 기존 change log 테이블이나 증분 cursor가 있을 때
