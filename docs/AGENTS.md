# RouteFlow — AGENTS.md

## 프로젝트 개요

**RouteFlow**는 TypeScript/Node.js 기반의 반응형 백엔드 프레임워크다.
REST처럼 쉽게 쓰지만, DB 변경이 발생하면 구독 중인 클라이언트에 자동으로 푸시된다.
특정 DB나 플랫폼에 종속되지 않는 어댑터 패턴으로 설계한다.

제품명, 패키지 스코프, 문서 예제는 모두 `RouteFlow` 기준으로 본다.

---

## 핵심 철학

1. **REST처럼 쓴다** — 기존 HTTP 지식으로 바로 사용 가능
2. **실시간은 자동** — 개발자가 WebSocket을 직접 다루지 않는다
3. **DB 무관** — 공식 지원 DB는 네이티브 어댑터, 나머지는 PollingAdapter/CDC 브리지로 확장
4. **타입 안전** — 엔드포인트부터 클라이언트 푸시까지 TypeScript 타입 유지
5. **제로 부가 인프라** — Redis, 별도 메시지 큐 없이도 동작하는 기본 모드

## 기존과의 차이

기존 방식은 보통 HTTP API, WebSocket/SSE, DB 변경 감지, 클라이언트 이벤트 처리가 분리된다.

RouteFlow는 이걸 하나로 묶는다. 개발자는 라우트를 만들고 `@Reactive`만 붙이면 되고, 프레임워크가 DB 변경을 감지해서 해당 live 엔드포인트 결과를 다시 계산해 푸시한다. 실시간 기능을 별도 시스템으로 붙이는 게 아니라 API 자체를 live하게 만드는 것이 차이점이다.

## MVP에서 증명해야 할 것

1. `@Reactive`를 붙였더니 바로 자동 갱신되는 live 경험
2. DB 어댑터를 바꿔도 API 코드가 거의 유지되는 경험
3. WebSocket 내부 구조를 몰라도 REST처럼 개발할 수 있다는 경험

---

## 디렉토리 구조

```text
routeflow/
├── docs/
├── examples/
│   └── basic/
├── packages/
│   ├── core/
│   ├── client/
│   ├── adapter-postgres/
│   ├── adapter-mysql/
│   ├── adapter-mongodb/
│   ├── adapter-redis/
│   ├── adapter-elasticsearch/
│   ├── adapter-opensearch/
│   ├── adapter-dynamodb/
│   └── adapter-snowflake/
└── package.json
```

## 기술 스택

- **런타임**: Node.js 20+
- **언어**: TypeScript 5+
- **빌드**: tsup
- **모노레포**: pnpm workspaces + turborepo
- **테스트**: Vitest
- **HTTP 서버**: 내부적으로 Fastify 사용
- **WebSocket**: ws 라이브러리
- **SSE**: 네이티브 HTTP 스트림

## 핵심 API 설계

### 서버 사이드

```typescript
import { createApp, Reactive, Route } from '@routeflow/core'
import { PostgresAdapter } from '@routeflow/adapter-postgres'
import type { Context } from '@routeflow/core'

const app = createApp({
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  transport: 'websocket',
  port: 3000,
})

class OrderController {
  @Route('GET', '/orders/:userId')
  async getOrders(ctx: Context) {
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
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
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
  }
}

app.register(OrderController)
await app.listen()
```

### 클라이언트 사이드

```typescript
import { createClient } from '@routeflow/client'

const client = createClient('http://localhost:3000')
const orders = await client.get('/orders/123')
const unsubscribe = client.subscribe('/orders/123/live', (data) => {
  console.log('업데이트:', data)
})
```

## 구현 현황

### 완료
- [x] 모노레포 세팅
- [x] `@Route` 데코레이터 + HTTP 라우팅
- [x] `@Reactive` 데코레이터 기본 구조
- [x] WebSocket 전송 레이어
- [x] SSE 전송 레이어
- [x] DB 어댑터 인터페이스 정의
- [x] `MemoryAdapter`, `PollingAdapter`, 지원 매트릭스
- [x] 클라이언트 SDK + 자동 재연결
- [x] PostgreSQL 어댑터
- [x] 공식 지원 네이티브 패키지: MySQL, MongoDB, Redis, Elasticsearch, OpenSearch, DynamoDB, Snowflake

### 공식 지원 DB
- [x] PostgreSQL
- [x] MySQL
- [x] MongoDB
- [x] Redis
- [x] DynamoDB
- [x] Elasticsearch
- [x] OpenSearch
- [x] Snowflake

### 실험적/보류 DB
- [ ] MariaDB, MS SQL Server, SQLite
- [ ] BigQuery, Redshift, Azure Synapse
- [ ] Cassandra, Neo4j

## 코딩 규칙

- 파일명: `kebab-case.ts`
- 클래스명: `PascalCase`
- `any` 사용 금지, 필요 시 `unknown` 후 좁히기
- 비동기는 `async/await`
- 에러는 `ReactiveApiError` 사용
- public API에는 JSDoc 유지
