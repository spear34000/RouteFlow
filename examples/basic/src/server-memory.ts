/**
 * RouteFlow MVP proof #1 and #3:
 * - REST-style route + @Reactive becomes live
 * - The client still subscribes by path without managing WS channels
 */
import { createApp } from '@routeflow/core'
import { MemoryAdapter } from '@routeflow/core/adapters'
import { registerDemoUi } from './register-demo-ui.js'
import { createItemController, MemoryChangeEmitter, MemoryItemStore, seedItems } from './shared.js'

const adapter = new MemoryAdapter()
const store = new MemoryItemStore(seedItems)
const ItemController = createItemController(store, new MemoryChangeEmitter(adapter))
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port = Number(process.env['PORT'] ?? 3000)

const app = createApp({
  adapter,
  transport,
  port,
})

registerDemoUi(app, {
  title: 'Memory adapter, live endpoint',
  subtitle:
    'The route code stays REST-shaped. RouteFlow pushes fresh /items/live results when the in-memory adapter emits a change.',
  transport,
})
app.register(ItemController)
await app.listen()

let tick = 0
setInterval(async () => {
  tick++
  const item = await store.create(`Auto-item #${tick}`)
  adapter.emit('items', { operation: 'INSERT', newRow: item, oldRow: null })
  console.log(`[memory] emitted INSERT for item #${item.id}`)
}, 3_000)

console.log(`[memory] RouteFlow demo ready on http://localhost:${port} (${transport})`)
