/**
 * Todo example — simplest end-to-end RouteFlow app for real usage.
 *
 * Run:
 *   pnpm run example:todos
 *
 * Then in another terminal:
 *   curl http://localhost:3020/todos
 *   curl -X POST http://localhost:3020/todos \
 *     -H "Content-Type: application/json" \
 *     -d '{"title":"Ship RouteFlow docs"}'
 *
 * Live endpoint:
 *   GET /todos/live
 */

import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'

const dbPath = process.env['DB_PATH'] ?? './data/todos.db'
const port = Number(process.env['PORT'] ?? 3020)
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'

const db = new RouteStore(dbPath)
const todos = db.table('todos', {
  title: 'text',
  done: 'integer',
  createdAt: 'text',
})

await todos.seed([
  { title: 'Read the RouteFlow quickstart', done: 0, createdAt: '2026-04-17T00:00:00.000Z' },
  { title: 'Open /todos/live in a client', done: 0, createdAt: '2026-04-17T00:00:01.000Z' },
])

const app = createApp({ adapter: db, port, transport })

app
  .flow('/todos', todos, {
    only: ['list', 'get', 'create', 'update', 'delete', 'live'],
  })
  .openapi({ title: 'Todo Example API', version: '1.0.0' })
  .listen()

console.log(`[todos] Ready → http://localhost:${port} (${transport})`)
console.log(`[todos] DB    → ${dbPath}`)
console.log(`[todos] Docs  → http://localhost:${port}/_docs`)
console.log('[todos] Try   → GET /todos, POST /todos, subscribe to /todos/live')
