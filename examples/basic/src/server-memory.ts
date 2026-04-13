import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'
import { registerDemoUi } from './register-demo-ui.js'
import { ItemController, seedItems } from './shared.js'

const dbPath    = process.env['DB_PATH'] ?? './data/routeflow.db'
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port      = Number(process.env['PORT'] ?? 3000)

const db    = new RouteStore(dbPath)
const items = db.table('items', { name: 'text', createdAt: 'text' })
await items.seed(seedItems)

const app = createApp({ adapter: db, transport, port })

registerDemoUi(app, {
  title:    'RouteStore (SQLite)',
  subtitle: `데이터가 ${dbPath} 에 저장됩니다. 서버를 재시작해도 데이터가 유지됩니다.`,
  transport,
})
app.register(new ItemController(items))
await app.listen()

console.log(`[RouteStore] DB: ${dbPath}`)
console.log(`[RouteStore] Ready on http://localhost:${port} (${transport})`)
