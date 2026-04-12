# @routeflow/adapter-opensearch

RouteFlow 공식 지원 OpenSearch 어댑터.

구조는 `@routeflow/adapter-elasticsearch`와 동일하며, OpenSearch change source를 받아 live 엔드포인트 갱신에 연결합니다.

## 설치

```bash
pnpm add @routeflow/adapter-opensearch
```

## 사용법

```typescript
import { createApp } from '@routeflow/core'
import { OpenSearchAdapter } from '@routeflow/adapter-opensearch'

const app = createApp({
  adapter: new OpenSearchAdapter({
    source: openSearchChangeSource,
  }),
  port: 3000,
})
```

## 포지션

- 상태: `official`
- 권장 대상: OpenSearch + 외부 CDC/poller/queue 조합
- 연결 방식: external change source
