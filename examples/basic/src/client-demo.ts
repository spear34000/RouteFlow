/**
 * Basic RouteFlow example — Node.js client demo
 *
 * Requires the server to be running:
 *   pnpm run example:memory
 *
 * Run this in a separate terminal:
 *   pnpm run example:client
 */

import { createClient } from '@spear340000/client'

// Node 22+ has native WebSocket; polyfill for older versions
// @ts-ignore — ws is available in the examples workspace via the server dep chain
import { WebSocket as NodeWebSocket } from 'ws'
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-ignore
  globalThis.WebSocket = NodeWebSocket
}

const client = createClient('http://localhost:3000', {
  reconnect: { maxAttempts: 5, initialDelayMs: 1000 },
  onError: (err) => console.error('[client] realtime error:', err),
})

// ---------------------------------------------------------------------------
// One-off REST calls
// ---------------------------------------------------------------------------

console.log('[client] Fetching current items over REST...')
const snapshot = await client.get<unknown[]>('/items')
console.log('[client] Current items:', snapshot)

console.log('[client] Creating a new item over REST...')
const created = await client.post<unknown>('/items', { name: 'Cherry' })
console.log('[client] Created:', created)

// ---------------------------------------------------------------------------
// Real-time subscription
// ---------------------------------------------------------------------------

console.log('[client] Subscribing to /items/live...')
const unsubscribe = client.subscribe<unknown[]>('/items/live', (data) => {
  console.log('[client] Push received without manual WS event handling. Item count:', Array.isArray(data) ? data.length : '?')
})

// Unsubscribe after 15 seconds
setTimeout(() => {
  console.log('[client] Unsubscribing.')
  unsubscribe()
  client.destroy()
  process.exit(0)
}, 15_000)
