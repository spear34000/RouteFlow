import type { ChangeEvent, DatabaseAdapter } from '../types.js'

/**
 * In-memory database adapter for testing and local development.
 * No real database connection is needed — changes are triggered manually via `emit()`.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter()
 * await adapter.connect()
 *
 * adapter.onChange('orders', (event) => console.log(event))
 *
 * adapter.emit('orders', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
 * ```
 */
export class MemoryAdapter implements DatabaseAdapter {
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private connected = false

  /** No-op — MemoryAdapter requires no real connection. */
  async connect(): Promise<void> {
    this.connected = true
  }

  /** No-op — clears all listeners on disconnect. */
  async disconnect(): Promise<void> {
    this.listeners.clear()
    this.connected = false
  }

  /**
   * Register a listener for changes on a specific table.
   * @returns An unsubscribe function.
   */
  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) {
      this.listeners.set(table, new Set())
    }
    this.listeners.get(table)!.add(callback)

    return () => {
      this.listeners.get(table)?.delete(callback)
    }
  }

  /**
   * Manually emit a change event on a table.
   * Useful in tests and examples to simulate DB changes without a real database.
   *
   * @param table - Table name to emit the event on
   * @param event - Change event data (table and timestamp are filled in automatically)
   */
  emit(table: string, event: Omit<ChangeEvent, 'table' | 'timestamp'>): void {
    const fullEvent: ChangeEvent = {
      ...event,
      table,
      timestamp: Date.now(),
    }

    const callbacks = this.listeners.get(table)
    if (!callbacks) return

    for (const cb of callbacks) {
      cb(fullEvent)
    }
  }

  /** Returns true if connect() has been called and disconnect() has not. */
  get isConnected(): boolean {
    return this.connected
  }
}
