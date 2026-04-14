# RouteFlow Development Guide

## Project Structure

```
RouteFlow/
├── packages/
│   └── routeflow/              # 통합 패키지
│       ├── src/
│       │   ├── index.ts        # Core exports (createApp, Route, Reactive)
│       │   ├── client/         # Client SDK
│       │   └── adapters/       # Database adapters
│       │       ├── postgres/
│       │       ├── mongodb/
│       │       ├── mysql/
│       │       ├── redis/
│       │       ├── dynamodb/
│       │       ├── elasticsearch/
│       │       ├── opensearch/
│       │       ├── snowflake/
│       │       └── cassandra/
│       ├── package.json
│       ├── tsconfig.json
│       └── tsup.config.ts
├── examples/
│   └── basic/                  # 예제 코드
├── docs/                       # 문서
├── package.json               # 루트 워크스페이스
└── DEVELOPMENT.md            # 이 파일
```

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9.0.0
- PostgreSQL (optional, for postgres demo)

### Installation

```bash
pnpm install
```

### Build

```bash
# 전체 빌드
pnpm build

# 개별 패키지 빌드
pnpm --filter routeflow-api build
```

### Development Mode

```bash
pnpm dev
```

## Running Examples

### Memory Adapter Demo

```bash
# WebSocket (port 3000)
pnpm run example:memory

# SSE (port 3001)
pnpm run example:memory:sse
```

### PostgreSQL Adapter Demo

```bash
# WebSocket (port 3002)
ROUTEFLOW_POSTGRES_URL=postgresql://localhost:5432/routeflow pnpm run example:postgres

# SSE (port 3003)
ROUTEFLOW_POSTGRES_URL=postgresql://localhost:5432/routeflow pnpm run example:postgres:sse
```

### Client Demo

```bash
# 다른 터미널에서
pnpm run example:client
```

## Package Development

### Adding a New Adapter

1. **Adapter implementation** (`src/adapters/{name}/`)
   ```typescript
   // src/adapters/{name}/{name}-adapter.ts
   import type { ChangeEvent, DatabaseAdapter } from '../../core/types.js'
   import { ReactiveApiError } from '../../core/errors.js'
   
   export class NewAdapter implements DatabaseAdapter {
     // Implementation
   }
   ```

2. **Types** (`src/adapters/{name}/types.ts`)
   ```typescript
   import type { ChangeEvent } from '../../core/types.js'
   
   export interface NewAdapterOptions {
     // Options
   }
   ```

3. **Entry point** (`src/adapters/{name}.ts`)
   ```typescript
   export { NewAdapter } from './{name}/{name}-adapter.js'
   export type { NewAdapterOptions } from './{name}/types.js'
   ```

4. **Update package.json exports**
   ```json
   "./adapters/{name}": {
     "types": "./dist/adapters/{name}.d.ts",
     "import": "./dist/adapters/{name}.mjs",
     "require": "./dist/adapters/{name}.js"
   }
   ```

5. **Update tsup.config.ts**
   ```typescript
   entry: {
     // ... existing entries
     'adapters/{name}': 'src/adapters/{name}.ts',
   }
   ```

6. **Update peerDependencies (optional)**
   ```json
   "peerDependencies": {
     "{db-driver}": "^{version}"
   },
   "peerDependenciesMeta": {
     "{db-driver}": { "optional": true }
   }
   ```

### Adding Core Features

1. **Decorators** (`src/core/decorator/`)
   - `@Route` - HTTP route registration
   - `@Reactive` - Real-time subscription

2. **Transport** (`src/core/transport/`)
   - `WebSocketTransport`
   - `SseTransport`

3. **Adapter Interface** (`src/core/adapter/`)
   - `MemoryAdapter`
   - `PollingAdapter`

## Testing

### Unit Tests

```bash
pnpm --filter routeflow-api test
```

### Integration Tests (PostgreSQL)

```bash
POSTGRES_TEST_URL=postgresql://user:pass@localhost:5432/testdb \
  pnpm --filter routeflow-api test:integration
```

### Type Checking

```bash
pnpm run example:build
```

## Publishing

### Version Bump

```bash
cd packages/routeflow
npm version patch|minor|major
```

### Build and Publish

```bash
pnpm --filter routeflow-api build
pnpm --filter routeflow-api publish --access public
```

### Deprecate Old Packages

```bash
npm deprecate @spear340000/{package} "message"
```

## Architecture Decisions

### Why Single Package?

- **Simpler installation**: `npm install routeflow-api` vs 10 separate packages
- **Better tree-shaking**: Unused adapters don't bloat bundle
- **Optional peer deps**: Only install DB drivers you need
- **Unified versioning**: No version mismatch issues

### Subpath Exports

```typescript
// Core
import { createApp } from 'routeflow-api'

// Client
import { createClient } from 'routeflow-api/client'

// Adapters
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'
```

### Adapter Pattern

Each adapter implements `DatabaseAdapter`:

```typescript
interface DatabaseAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  onChange(table: string, callback: (event: ChangeEvent) => void): () => void
}
```

## Code Style

### Imports

- Use `.js` extensions for TypeScript imports
- Use relative paths for internal imports
- Use named exports

```typescript
// Good
import { createApp } from './core/index.js'
import type { Context } from './core/types.js'

// Bad
import { createApp } from './core'
import { createApp } from './core/index'
```

### Error Handling

Use `ReactiveApiError` for framework errors:

```typescript
import { ReactiveApiError } from './core/errors.js'

throw new ReactiveApiError('HANDLER_ERROR', 'Something went wrong')
```

### Type Exports

Export types separately:

```typescript
export { MyClass } from './my-class.js'
export type { MyOptions } from './types.js'
```

## Common Tasks

### Add New HTTP Method Support

Edit `src/core/types.ts`:

```typescript
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' // add new
```

### Add New Transport

1. Create `src/core/transport/{name}-transport.ts`
2. Implement transport interface
3. Add to `src/core/index.ts` exports
4. Update `createApp()` options type

### Update Documentation

- `README.md` - 메인 문서
- `docs/getting-started.md` - 시작 가이드
- `docs/server.md` - 서버 API
- `docs/client.md` - 클라이언트 API
- `docs/adapters.md` - 어댑터 가이드
- `packages/routeflow/README.md` - npm 패키지 README

## Debugging

### Enable Fastify Logging

```typescript
const app = createApp({
  adapter,
  port: 3000,
  // Enable Fastify logging
  logger: true
})
```

### Client Debug

```typescript
const client = createClient('http://localhost:3000', {
  onError: (err) => console.error('[debug]', err),
})
```

## Troubleshooting

### Build Failures

```bash
# Clean and rebuild
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build
```

### Type Errors

```bash
# Check TypeScript without emit
pnpm run example:build
```

### Peer Dependency Warnings

Optional peer deps are expected. Install only what you need:

```bash
npm install routeflow-api pg  # for PostgreSQL
```

## Release Checklist

- [ ] Version bump in `package.json`
- [ ] Update `CHANGELOG.md` or release notes
- [ ] Build passes
- [ ] Tests pass
- [ ] Type checking passes
- [ ] Examples run
- [ ] Publish to npm
- [ ] Tag release on GitHub

## Links

- npm: https://www.npmjs.com/package/routeflow-api
- Repository: https://github.com/spear34000/RouteFlow
