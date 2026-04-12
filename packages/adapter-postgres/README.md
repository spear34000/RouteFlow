# @spear340000/adapter-postgres

RouteFlow 공식 지원 PostgreSQL 어댑터.

기존 REST 엔드포인트 작성 방식은 유지하면서, PostgreSQL 변경이 생기면 해당 live 엔드포인트를 구독 중인 클라이언트에게 최신 결과를 자동 푸시하는 흐름에 연결됩니다.

`LISTEN/NOTIFY` 기반으로 DB 변경을 감지합니다.

## 설치

```bash
pnpm add @spear340000/adapter-postgres pg
```

## 사용법

```typescript
import { createApp } from '@spear340000/core'
import { PostgresAdapter } from '@spear340000/adapter-postgres'

const app = createApp({
  adapter: new PostgresAdapter({
    connectionString: process.env.DATABASE_URL,
  }),
  port: 3000,
})
```

이 어댑터는 `@Reactive({ watch: 'table' })`로 선언한 엔드포인트와 연결되어, 테이블 변경 시 해당 엔드포인트 결과를 다시 계산하게 만듭니다.

## 동작 원리

1. `connect()` 시 전용 `pg.Client`로 연결 후 공유 트리거 함수 설치
2. `onChange(table, cb)` 호출 시 해당 테이블에 `AFTER INSERT OR UPDATE OR DELETE` 트리거 자동 설치
3. 변경 발생 → 트리거가 `pg_notify('reactive_api_changes', payload)` 호출
4. LISTEN 커넥션이 페이로드를 수신 → `ChangeEvent`로 변환 → 콜백 호출
5. `disconnect()` 시 모든 트리거와 함수 자동 제거

## 포지션

- 상태: `official`
- 권장 대상: PostgreSQL 기반 서비스
- 연결 방식: 네이티브 DB 변경 감지

## 옵션

```typescript
new PostgresAdapter({
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',
  schema: 'public',          // 기본값
  triggerPrefix: 'reactive_api', // 기본값
})
```

## 주의사항

- **8KB 제한**: PostgreSQL `NOTIFY` 페이로드는 8000바이트 미만이어야 합니다. 큰 행은 `newRow/oldRow`가 `null`로 전달됩니다. 필요 시 `event.newRow === null` 검사 후 재조회하세요.
- **전용 커넥션**: LISTEN을 위해 별도 `pg.Client`를 유지합니다. 애플리케이션의 커넥션 풀과 별개입니다.
- **트리거 권한**: 어댑터를 실행하는 DB 유저에게 해당 테이블에 트리거를 생성할 권한이 필요합니다.

## 통합 테스트

```bash
POSTGRES_TEST_URL=postgresql://user:pass@localhost:5432/testdb \
  pnpm test:integration
```
