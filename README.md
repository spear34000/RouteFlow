# RouteFlow

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/routeflow-api)](https://www.npmjs.com/package/routeflow-api)
[![npm downloads](https://img.shields.io/npm/dw/routeflow-api)](https://www.npmjs.com/package/routeflow-api)
[![CI](https://img.shields.io/github/actions/workflow/status/spear34000/RouteFlow/ci.yml?branch=main&label=CI)](https://github.com/spear34000/RouteFlow/actions/workflows/ci.yml)
[![Transport](https://img.shields.io/badge/Transport-WebSocket%20%7C%20SSE-16110F)](#공식-지원)
[![Adapters](https://img.shields.io/badge/Official%20Adapters-8-DB5C34)](#공식-지원)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue)](./LICENSE)

> **"REST처럼 쓰는데, DB 변경이 생기면 구독 중인 클라이언트에 자동으로 푸시된다."**

기존 REST API는 그대로 두고, DB 변경 시 최신 route 결과를 자동으로 푸시하는 live endpoint를 붙일 수 있습니다.

- Query-aware live subscriptions
- Smart delta push
- Live include responses

## 왜 필요한가

보통 실시간 기능은 CRUD API를 만든 뒤에 따로 붙습니다.

- WebSocket 채널을 따로 설계해야 한다
- `?roomId=1&limit=10` 같은 query마다 fan-out을 다시 나눠야 한다
- `?include=author` 같은 relation 응답은 관련 테이블이 바뀔 때 다시 계산해야 한다
- 단순 feed는 delta로 보내고, 복잡한 응답은 snapshot으로 보내는 판단도 직접 해야 한다

RouteFlow는 이 복잡도를 "route 결과" 기준으로 다시 묶습니다.

- REST endpoint를 먼저 만든다
- 같은 자원에 `/live`를 붙인다
- DB 변경이 생기면 해당 route 결과를 다시 계산해서 구독자에게 보낸다

즉, 실시간 시스템을 따로 설계하는 대신 "기존 API를 live하게 만드는" 쪽에 집중할 수 있습니다.

## 왜 RouteFlow인가

Supabase Realtime, Firebase, Prisma Pulse 같은 도구들은 강력하지만 특정 플랫폼이나 데이터 모델에 더 가까운 편입니다.

RouteFlow는 다른 문제를 겨냥합니다.

- 이미 REST 중심 API 설계가 있다
- 특정 DB나 BaaS에 묶이고 싶지 않다
- query/filter/include가 붙은 응답을 그대로 live하게 만들고 싶다
- 운영에서는 PostgreSQL, 로컬에서는 SQLite처럼 저장소를 바꿔 끼우고 싶다

핵심 차별점은 세 가지입니다.

1. Query-aware live
경로만 보는 게 아니라 query가 달라지면 구독 그룹도 달라집니다.

2. Smart delta push
append/feed형 route는 delta로, 복잡한 route는 snapshot으로 안전하게 동작합니다.

3. Live include
`?include=author` 같은 relation 응답도 관련 데이터 변경 시 다시 계산할 수 있습니다.

더 자세한 설명은 [`docs/why-routeflow.md`](./docs/why-routeflow.md)에 정리되어 있습니다.

## 15초 예제

```ts
app.flow('/rooms/:roomId/messages', messages, {
  push: 'smart',
  queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
  query: 'auto',
  relations: {
    author: { store: users, foreignKey: 'authorId', watch: 'users' },
  },
  liveInclude: true,
})
```

이 설정 하나로 다음이 같이 붙습니다.

- `/rooms/1/messages/live?limit=10` 같은 room-scoped live route
- query별 fan-out 분리
- 단순한 경우 delta push
- `?include=author` 응답의 relation 변경 재계산

## 어떤 문제를 쉽게 푸나

- 채팅, 알림, activity feed 같은 append형 live API
- room, team, project 단위로 나뉘는 scoped subscription
- REST 목록 응답에 `?limit`, `?after`, `?order` 같은 query가 붙는 경우
- `?include=user` 같은 관계 확장 응답을 실시간으로 유지해야 하는 경우
- 로컬 개발은 SQLite, 운영은 Postgres처럼 저장소를 바꿔야 하는 경우

## 언제 잘 맞나

- REST API를 이미 쓰고 있고, 그 API를 live하게 만들고 싶을 때
- 서버가 response shape를 통제해야 할 때
- DB 변경을 route 결과와 직접 연결하고 싶을 때
- 실시간 layer를 애플리케이션 코드에서 직접 운영하고 싶을 때

## 언제 안 맞나

- DB row change 자체를 그대로 스트리밍하면 충분한 경우
- 특정 BaaS 플랫폼의 생태계에 깊게 묶여도 괜찮은 경우
- route 결과보다 이벤트 로그/이벤트 소싱 자체가 중심인 경우

## 문서

- [`docs/getting-started.md`](./docs/getting-started.md)
- [`docs/why-routeflow.md`](./docs/why-routeflow.md)
- [`docs/usage-guide.md`](./docs/usage-guide.md)
- [`docs/server.md`](./docs/server.md)
- [`docs/client.md`](./docs/client.md)
- [`docs/adapters.md`](./docs/adapters.md)
- [`docs/examples.md`](./docs/examples.md)
- [`docs/releases/v1.0.24.md`](./docs/releases/v1.0.24.md)
- [`docs/releases/v1.0.22.md`](./docs/releases/v1.0.22.md)
- [`SKILLS.md`](./SKILLS.md)

## 프로젝트 상태

- 이슈: [GitHub Issues](https://github.com/spear34000/RouteFlow/issues)
- 기여 가이드: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 보안 신고: [`SECURITY.md`](./SECURITY.md)
- 행동 강령: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- 지원 안내: [`SUPPORT.md`](./SUPPORT.md)

## 설치

```bash
npm install routeflow-api
```

PostgreSQL 어댑터를 같이 쓰려면:

```bash
npm install routeflow-api pg
```

> `reflect-metadata`는 `routeflow-api`에 포함되어 있으므로 별도 설치가 필요 없습니다.

## Node.js 호환성

- 코어 HTTP/WebSocket/SSE 기능은 현재 Node.js LTS 환경에서 사용할 수 있습니다.
- SQLite `RouteStore`는 내장 `node:sqlite`를 사용하므로 Node.js `22.13+`가 필요합니다.
- 2026-04-17 기준 최신 LTS는 `Node.js 24.15.0 (LTS)`이며, SQLite 사용 시 이 버전을 권장합니다.
- `routeflow-api/sqlite`는 이제 ESM과 CommonJS `require()` 양쪽에서 동작합니다.

## 빠른 시작

### 5분 체험

가장 빠른 시작은 Todo 예제입니다.

```bash
pnpm install
pnpm run example:todos
```

다른 터미널에서:

```bash
curl http://localhost:3020/todos

curl -X POST http://localhost:3020/todos \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship RouteFlow docs","done":0,"createdAt":"2026-04-17T00:00:00.000Z"}'
```

자동 검증:

```bash
pnpm run example:todos:smoke
```

### 차별화 예제

RouteFlow의 고유 기능을 한 번에 보려면 이 예제를 실행하면 됩니다.

```bash
pnpm run example:differentiation
pnpm run example:differentiation:smoke
```

이 예제는 다음을 함께 보여줍니다.

- `/rooms/:roomId/messages/live?include=author&limit=10`
  Query-aware live + live include
- `/activity/live`
  `push: 'smart'`가 단순 route에서는 delta로 동작

### 파일 저장 서버 (SQLite, 권장)

`RouteStore`는 DatabaseAdapter와 테이블 CRUD를 하나로 통합합니다.
Node.js 22.13+ 내장 `node:sqlite`를 사용하므로 추가 패키지가 없습니다.

```typescript
import { createApp, Reactive, Route } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import type { Context } from 'routeflow-api'

const db = new RouteStore('./data/app.db')
const items = db.table('items', { name: 'text', createdAt: 'text' })

await items.seed([{ name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' }])

class ItemController {
  @Route('GET', '/items')
  async getItems(_ctx: Context) {
    return items.list()
  }

  @Route('POST', '/items')
  async createItem(ctx: Context) {
    const body = ctx.body as { name: string }
    return items.create({ name: body.name, createdAt: new Date().toISOString() })
  }

  @Reactive({ watch: 'items' })
  @Route('GET', '/items/live')
  async getLiveItems(_ctx: Context) {
    return items.list()
  }
}

const app = createApp({ adapter: db, port: 3000 })
app.register(ItemController)
await app.listen()
```

### 클라이언트

```typescript
import { createClient } from 'routeflow-api/client'

const client = createClient('http://localhost:3000')

const items = await client.get('/items')

const unsubscribe = client.subscribe('/items/live', (latest) => {
  console.log('업데이트:', latest)
})
```

## 공식 지원

공식 진입점:

- `routeflow-api`
- `routeflow-api/sqlite`
- `routeflow-api/client`
- `routeflow-api/adapters/postgres`
- `routeflow-api/adapters/mongodb`
- `routeflow-api/adapters/mysql`
- `routeflow-api/adapters/redis`
- `routeflow-api/adapters/dynamodb`
- `routeflow-api/adapters/elasticsearch`
- `routeflow-api/adapters/opensearch`
- `routeflow-api/adapters/snowflake`
- `routeflow-api/adapters/cassandra`
- `routeflow-api/adapters/kafka`
- `routeflow-api/adapters/webhook`

지원 전송:

- WebSocket
- SSE

## 라이선스

Apache 2.0
