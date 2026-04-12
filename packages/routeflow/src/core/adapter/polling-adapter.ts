import type { ChangeEvent, DatabaseAdapter } from '../types.js'

export interface PollingReadResult<T = unknown, TCursor = unknown> {
  events: Array<Omit<ChangeEvent<T>, 'table' | 'timestamp'> & Partial<Pick<ChangeEvent<T>, 'table' | 'timestamp'>>>
  cursor?: TCursor
}

export interface PollingReadContext<TCursor = unknown> {
  cursor: TCursor | undefined
  table: string
}

export interface PollingAdapterOptions<TCursor = unknown> {
  intervalMs?: number
  now?: () => number
  onError?: (error: unknown, context: { table: string }) => void
  readChanges: (
    context: PollingReadContext<TCursor>,
  ) => Promise<PollingReadResult<unknown, TCursor>>
}

/**
 * Generic polling-based adapter for databases without a native RouteFlow adapter yet.
 * It works with any backend as long as callers can periodically read a change feed.
 */
export class PollingAdapter<TCursor = unknown> implements DatabaseAdapter {
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly cursors: Map<string, TCursor | undefined> = new Map()
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private readonly activeTables: Set<string> = new Set()
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly readChanges: PollingAdapterOptions<TCursor>['readChanges']
  private readonly onError?: PollingAdapterOptions<TCursor>['onError']
  private connected = false

  constructor(options: PollingAdapterOptions<TCursor>) {
    this.intervalMs = options.intervalMs ?? 1_000
    this.now = options.now ?? (() => Date.now())
    this.readChanges = options.readChanges
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    this.connected = true

    for (const table of this.listeners.keys()) {
      this.ensurePolling(table)
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false

    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }

    this.timers.clear()
    this.activeTables.clear()
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) {
      this.listeners.set(table, new Set())
    }

    this.listeners.get(table)!.add(callback)
    this.ensurePolling(table)

    return () => {
      const callbacks = this.listeners.get(table)
      if (!callbacks) return

      callbacks.delete(callback)

      if (callbacks.size === 0) {
        this.listeners.delete(table)
        this.stopPolling(table)
      }
    }
  }

  private ensurePolling(table: string): void {
    if (!this.connected || this.activeTables.has(table)) return

    this.activeTables.add(table)
    void this.poll(table)
  }

  private stopPolling(table: string): void {
    const timer = this.timers.get(table)
    if (timer) clearTimeout(timer)

    this.timers.delete(table)
    this.activeTables.delete(table)
    this.cursors.delete(table)
  }

  private scheduleNext(table: string): void {
    if (!this.connected || !this.listeners.has(table)) {
      this.stopPolling(table)
      return
    }

    const timer = setTimeout(() => {
      void this.poll(table)
    }, this.intervalMs)

    this.timers.set(table, timer)
  }

  private async poll(table: string): Promise<void> {
    if (!this.connected || !this.listeners.has(table)) {
      this.stopPolling(table)
      return
    }

    try {
      const result = await this.readChanges({
        table,
        cursor: this.cursors.get(table),
      })

      this.cursors.set(table, result.cursor)

      for (const event of result.events) {
        this.emit(table, event)
      }
    } catch (error) {
      this.onError?.(error, { table })
    } finally {
      this.activeTables.delete(table)
      this.scheduleNext(table)
    }
  }

  private emit(
    defaultTable: string,
    event: Omit<ChangeEvent, 'table' | 'timestamp'> & Partial<Pick<ChangeEvent, 'table' | 'timestamp'>>,
  ): void {
    const fullEvent: ChangeEvent = {
      ...event,
      table: event.table ?? defaultTable,
      timestamp: event.timestamp ?? this.now(),
    }

    const callbacks = this.listeners.get(fullEvent.table)
    if (!callbacks) return

    for (const callback of callbacks) {
      callback(fullEvent)
    }
  }
}
