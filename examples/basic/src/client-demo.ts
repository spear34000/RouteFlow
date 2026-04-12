/**
 * RouteFlow client demo — Node.js
 *
 * 1. Start the server first:
 *      pnpm run example:memory
 *
 * 2. Run this in a separate terminal:
 *      pnpm run example:client
 */

import { createClient } from 'routeflow-api/client'

// Node 22+ has native WebSocket; polyfill for older versions
// @ts-ignore
import { WebSocket as NodeWebSocket } from 'ws'
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-ignore
  globalThis.WebSocket = NodeWebSocket
}

interface Item {
  id: number
  name: string
  createdAt: string
}

const client = createClient('http://localhost:3000', {
  reconnect: { maxAttempts: 5, initialDelayMs: 1_000 },
  onError: (err) => console.error('[client] error:', err),
})

// ── REST ──────────────────────────────────────────────────────────────────

console.log('[client] GET /items')
const snapshot = await client.get<Item[]>('/items')
console.log('[client] snapshot:', snapshot)

console.log('[client] POST /items { name: "Cherry" }')
const created = await client.post<Item>('/items', { name: 'Cherry' })
console.log('[client] created:', created)

// ── Live subscription ─────────────────────────────────────────────────────

console.log('[client] subscribing to /items/live …')
const unsubscribe = client.subscribe<Item[]>('/items/live', (items) => {
  console.log(`[client] push — ${items.length} item(s):`, items.map((i) => i.name).join(', '))
})

// Stop after 15 s
setTimeout(() => {
  console.log('[client] unsubscribing')
  unsubscribe()
  client.destroy()
  process.exit(0)
}, 15_000)
