import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import { registerDemoUi } from './register-demo-ui.js'

const dbPath    = process.env['DB_PATH'] ?? './data/routeflow.db'
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port      = Number(process.env['PORT'] ?? 3000)

const db    = new RouteStore(dbPath)
const items = db.table('items', { name: 'text', createdAt: 'text' })
await items.seed([
  { name: 'Apple',  createdAt: '2026-01-01T00:00:00.000Z' },
  { name: 'Banana', createdAt: '2026-01-01T00:00:01.000Z' },
])

const app = createApp({ adapter: db, transport, port })

registerDemoUi(app, {
  title:    'RouteStore (SQLite)',
  subtitle: `데이터가 ${dbPath} 에 저장됩니다.`,
  transport,
})

// 한 줄로 CRUD + 실시간 reactive 등록
app
  .flow('/items', items)
  .openapi({ title: 'Items API' })
  .listen()

console.log(`[RouteStore] DB: ${dbPath}`)
console.log(`[RouteStore] Ready on http://localhost:${port} (${transport})`)
console.log(`[RouteStore] API docs → http://localhost:${port}/_docs`)
