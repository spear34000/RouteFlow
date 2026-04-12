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

```
flux/
├── packages/
│   ├── core/                  # 프레임워크 코어
│   │   ├── src/
│   │   │   ├── decorator/     # @Reactive, @Route 등 데코레이터
│   │   │   ├── reactive/      # 반응형 엔진 (구독/푸시 로직)
│   │   │   ├── adapter/       # DB 어댑터 인터페이스
│   │   │   └── transport/     # WebSocket, SSE 전송 레이어
│   │   └── package.json
│   ├── adapter-postgres/      # PostgreSQL 어댑터 (LISTEN/NOTIFY)
│   ├── adapter-mysql/         # MySQL 어댑터 (binlog source)
│   ├── adapter-mongodb/       # MongoDB 어댑터 (Change Streams)
│   ├── adapter-redis/         # Redis 어댑터 (pub/sub)
│   ├── adapter-elasticsearch/ # Elasticsearch 어댑터
│   ├── adapter-opensearch/    # OpenSearch 어댑터
│   ├── adapter-dynamodb/      # DynamoDB 어댑터
│   ├── adapter-snowflake/     # Snowflake 어댑터
│   └── client/                # 브라우저/Node 클라이언트 SDK
├── examples/
│   └── basic/                 # 기본 예제
└── package.json               # monorepo (pnpm workspaces)
```

---

## 기술 스택

- **런타임**: Node.js 20+
- **언어**: TypeScript 5+
- **빌드**: tsup
- **모노레포**: pnpm workspaces + turborepo
- **테스트**: Vitest
- **HTTP 서버**: 내부적으로 Fastify 사용 (사용자에게 노출 안 함)
- **WebSocket**: ws 라이브러리
- **SSE**: 네이티브 HTTP 스트림

---

## 핵심 API 설계

### 서버 사이드

```typescript
import { createApp, Reactive, Route } from '@routeflow/core'
import { PostgresAdapter } from '@routeflow/adapter-postgres'
import type { Context } from '@routeflow/core'

const app = createApp({
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  transport: 'websocket', // 또는 'sse'
  port: 3000,
})

class OrderController {
  // 일반 REST 엔드포인트
  @Route('GET', '/orders/:userId')
  async getOrders(ctx: Context) {
    return db.query('SELECT * FROM orders WHERE user_id = $1', [ctx.params.userId])
  }

  // 반응형 엔드포인트 — DB 변경 시 자동 푸시
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

// 일반 요청
const orders = await client.get('/orders/123')

// 반응형 구독 — 서버 푸시 자동 수신
const unsubscribe = client.subscribe('/orders/123/live', (data) => {
  console.log('업데이트:', data)
})
```

---

## 구현 현황

### 완료
- [x] 모노레포 세팅 (pnpm + turborepo)
- [x] `@Route` 데코레이터 + HTTP 라우팅 (Fastify 기반)
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

## 장점

- REST 스타일을 유지한 채 실시간 기능을 붙일 수 있음
- 클라이언트는 경로 기반 구독만 신경 쓰면 됨
- DB 어댑터를 교체해도 상위 API 모델을 비교적 유지할 수 있음
- 테스트에서 `MemoryAdapter`를 쓰기 쉬움

## 단점

- 변경 영향 범위 판별이 어려움
- 엔드포인트 재실행 비용이 커질 수 있음
- 권한/조인/파생 데이터가 섞이면 정확한 갱신 판별이 까다로움
- 멀티 인스턴스 구독 상태 동기화가 추가 과제임

---

## 코딩 규칙

- 파일명: `kebab-case.ts`
- 클래스명: `PascalCase`
- 인터페이스 prefix `I` 사용 안 함 — `type` 또는 `interface` 자유롭게
- `any` 사용 금지 — `unknown` 사용 후 타입 좁히기
- 비동기는 항상 `async/await`, `.then()` 체인 지양
- 에러는 `throw new ReactiveApiError(code, message)` 커스텀 에러 클래스 사용
- 모든 public API에 JSDoc 필수

---

## 테스트 규칙

- 단위 테스트: `*.test.ts` (같은 디렉토리)
- 통합 테스트: 패키지별 별도 설정 사용 가능
- 인메모리 어댑터로 DB 없이 테스트 가능하게 설계
- 커버리지 목표: 코어 패키지 80% 이상

---

## 하지 말 것

- 특정 DB에 종속된 코어 로직 작성 금지
- 사용자에게 WebSocket 프로토콜 직접 노출 금지
- `express` 직접 사용 금지 (Fastify만)
- 클라이언트 패키지에서 Node.js 전용 API 사용 금지 (브라우저 호환 필수)
