# @routeflow/adapter-cassandra

RouteFlow Cassandra 어댑터.

Cassandra CDC 또는 commit-log consumer가 발행하는 변경 이벤트를 RouteFlow `ChangeEvent`로 변환합니다. 현재 이 패키지는 공식 지원이 아니라 실험적/보류 상태입니다.

## 설치

```bash
pnpm add @routeflow/adapter-cassandra
```

## 사용법

```typescript
import { createApp } from '@routeflow/core'
import { CassandraAdapter } from '@routeflow/adapter-cassandra'

const app = createApp({
  adapter: new CassandraAdapter({
    source: cassandraCdcSource,
  }),
  port: 3000,
})
```

## 포지션

- 상태: `experimental`
- 권장 대상: 요청 기반 커스텀 통합
- 연결 방식: CDC source
