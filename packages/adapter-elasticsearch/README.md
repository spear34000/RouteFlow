# @routeflow/adapter-elasticsearch

RouteFlow 공식 지원 Elasticsearch 어댑터.

Elasticsearch 인덱스 변경을 직접 감지하기보다, 외부 change source가 발행한 이벤트를 받아 RouteFlow live 엔드포인트 갱신 신호로 사용합니다.

## 설치

```bash
pnpm add @routeflow/adapter-elasticsearch
```

Elasticsearch 자체에는 네이티브 change stream이 없으므로, poller나 CDC 브리지, 메시지 큐 컨슈머 등이 `change` 이벤트를 발행하는 source를 만들어 연결해야 합니다.

## 사용법

```typescript
import { createApp } from '@routeflow/core'
import { ElasticsearchAdapter } from '@routeflow/adapter-elasticsearch'

const app = createApp({
  adapter: new ElasticsearchAdapter({
    source: elasticsearchChangeSource,
  }),
  port: 3000,
})
```

## 포지션

- 상태: `official`
- 권장 대상: Elasticsearch + 외부 CDC/poller/queue 조합
- 연결 방식: external change source
