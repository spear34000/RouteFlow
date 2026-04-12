# @routeflow/adapter-mysql

RouteFlow 공식 지원 MySQL 어댑터.

기존 REST 엔드포인트는 그대로 두고, MySQL binlog 기반 변경을 RouteFlow live 엔드포인트 갱신으로 연결합니다.

## 설치

```bash
pnpm add @routeflow/adapter-mysql
```

binlog 이벤트 수집은 사용 중인 라이브러리로 연결하면 됩니다. 예를 들어 `zongji` 같은 소스가 `on('binlog')`, `start()`, `stop()` 인터페이스를 제공하면 바로 붙일 수 있습니다.

## 사용법

```typescript
import { createApp } from '@routeflow/core'
import { MySqlAdapter } from '@routeflow/adapter-mysql'

const adapter = new MySqlAdapter({
  source: zongjiLikeSource,
  schema: 'app',
  startOptions: {
    includeEvents: ['writerows', 'updaterows', 'deleterows'],
  },
})

createApp({ adapter, port: 3000 })
```

이 어댑터는 binlog 이벤트를 받아 `@Reactive` 엔드포인트가 다시 계산될 수 있게 `ChangeEvent`로 정규화합니다.

## 동작 원리

1. `connect()` 시 binlog 소스에 `binlog`/`error` 핸들러 등록
2. `WriteRows`, `UpdateRows`, `DeleteRows` 이벤트를 RouteFlow `ChangeEvent`로 정규화
3. `onChange(table)`에 등록된 테이블 구독자에게만 전달

## 포지션

- 상태: `official`
- 권장 대상: MySQL 기반 서비스
- 연결 방식: binlog event source
