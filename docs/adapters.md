# Adapter Guide

RouteFlow는 어댑터를 바꿔도 상위 API 코드를 유지하는 것을 목표로 합니다.

## 가장 쉬운 시작: `MemoryAdapter`

테스트, 문서 예제, 로컬 프로토타입에는 `MemoryAdapter`가 가장 간단합니다.

```ts
import { createApp, MemoryAdapter } from '@spear340000/core'

const adapter = new MemoryAdapter()
const app = createApp({ adapter, port: 3000 })
```

변경 이벤트는 수동으로 발생시킬 수 있습니다.

```ts
adapter.emit('items', {
  operation: 'INSERT',
  newRow: { id: 2, name: 'Orange' },
  oldRow: null,
})
```

## PostgreSQL

```ts
import { createApp } from '@spear340000/core'
import { PostgresAdapter } from '@spear340000/adapter-postgres'

const app = createApp({
  adapter: new PostgresAdapter({
    connectionString: process.env.ROUTEFLOW_POSTGRES_URL!,
  }),
  port: 3000,
})
```

핸들러와 클라이언트 코드는 그대로 두고, 어댑터만 교체합니다.

## 네이티브 공식 지원 어댑터

- `@spear340000/adapter-postgres`
- `@spear340000/adapter-mysql`
- `@spear340000/adapter-mongodb`
- `@spear340000/adapter-redis`
- `@spear340000/adapter-elasticsearch`
- `@spear340000/adapter-opensearch`
- `@spear340000/adapter-dynamodb`
- `@spear340000/adapter-snowflake`

## 네이티브 어댑터가 없을 때: `PollingAdapter`

```ts
import { createApp, PollingAdapter } from '@spear340000/core'

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

이 방식은 다음 경우에 적합합니다.

- 해당 DB용 공식 RouteFlow 패키지가 아직 없을 때
- CDC 대신 폴링으로도 충분할 때
- 기존 change log 테이블이나 증분 cursor가 있을 때

## 어떤 어댑터를 선택해야 하나

- 데모, 테스트, 학습: `MemoryAdapter`
- PostgreSQL 기반 실서비스: `PostgresAdapter`
- 공식 지원 DB: 해당 네이티브 패키지
- 비공식 DB 또는 사내 저장소: `PollingAdapter` 또는 CDC 브리지

## 공식 지원 DB

| DB | 상태 | 연결 방식 |
|---|---|---|
| PostgreSQL | `official` | native adapter |
| MySQL | `official` | native adapter |
| MongoDB | `official` | native adapter |
| Redis | `official` | native adapter |
| DynamoDB | `official` | native adapter |
| Elasticsearch | `official` | native adapter |
| OpenSearch | `official` | native adapter |
| Snowflake | `official` | native adapter |
