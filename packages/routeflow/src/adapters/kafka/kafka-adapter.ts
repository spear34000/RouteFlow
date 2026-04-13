import type { DatabaseAdapter, ChangeEvent } from '../../core/types.js'

export interface KafkaAdapterOptions {
  /**
   * Kafka broker addresses. e.g. `['localhost:9092']`
   */
  brokers: string[]
  /**
   * Consumer group ID. Default: `'routeflow'`.
   */
  groupId?: string
  /**
   * Client ID used in Kafka logs. Default: `'routeflow'`.
   */
  clientId?: string
  /**
   * Topics to consume. Each topic name is used as the RouteFlow **table name**
   * for `onChange(table, cb)` routing, so name topics to match your table names.
   *
   * @example `['orders', 'products']`
   */
  topics: string[]
  /**
   * Parse a raw Kafka message value into a RouteFlow `ChangeEvent` payload.
   * Return `null` to skip the message.
   *
   * Defaults to JSON-parsing the value as:
   * `{ operation: 'INSERT'|'UPDATE'|'DELETE', newRow?, oldRow? }`
   */
  parseMessage?: (
    topic: string,
    value: string | null,
  ) => Pick<ChangeEvent, 'operation'> & Partial<Pick<ChangeEvent, 'newRow' | 'oldRow'>> | null
  /**
   * Additional KafkaJS options passed directly to the `Kafka` constructor.
   * Use for SASL, SSL, retry settings, etc.
   */
  kafkaOptions?: Record<string, unknown>
}

type AnyConsumer = {
  connect(): Promise<void>
  subscribe(opts: { topics: string[]; fromBeginning: boolean }): Promise<void>
  run(opts: { eachMessage: (payload: { topic: string; message: { value: Buffer | null } }) => Promise<void> }): Promise<void>
  disconnect(): Promise<void>
}

/**
 * Kafka adapter for RouteFlow.
 *
 * Consumes messages from Kafka topics and converts them into RouteFlow
 * `ChangeEvent`s, enabling reactive push to WebSocket/SSE clients whenever
 * Kafka messages arrive.
 *
 * Requires `kafkajs` as a peer dependency (`npm i kafkajs`).
 *
 * Message format expected on each topic (JSON-encoded):
 * ```json
 * { "operation": "INSERT", "newRow": { ... }, "oldRow": null }
 * { "operation": "UPDATE", "newRow": { ... }, "oldRow": { ... } }
 * { "operation": "DELETE", "newRow": null,    "oldRow": { ... } }
 * ```
 *
 * @example
 * ```ts
 * import { KafkaAdapter } from 'routeflow-api/adapters/kafka'
 * import { createApp } from 'routeflow-api'
 *
 * const adapter = new KafkaAdapter({
 *   brokers: ['localhost:9092'],
 *   groupId: 'my-service',
 *   topics: ['orders', 'products'],
 * })
 *
 * const app = createApp({ adapter, port: 3000 })
 * app.register(new OrderController())
 * await app.listen()
 * ```
 */
export class KafkaAdapter implements DatabaseAdapter {
  private consumer: AnyConsumer | null = null
  private readonly listeners = new Map<string, Set<(event: ChangeEvent) => void>>()

  constructor(private readonly options: KafkaAdapterOptions) {}

  // ---------------------------------------------------------------------------
  // DatabaseAdapter interface
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.consumer) return

    // Dynamic import keeps kafkajs fully optional at install time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Kafka } = await import('kafkajs' as any)

    const kafka = new (Kafka as new (opts: unknown) => { consumer(opts: unknown): AnyConsumer })({
      clientId: this.options.clientId ?? 'routeflow',
      brokers: this.options.brokers,
      ...this.options.kafkaOptions,
    })

    const consumer = kafka.consumer({ groupId: this.options.groupId ?? 'routeflow' })
    await consumer.connect()
    await consumer.subscribe({ topics: this.options.topics, fromBeginning: false })

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        await this.handleMessage(topic, message.value)
      },
    })

    this.consumer = consumer
  }

  async disconnect(): Promise<void> {
    if (!this.consumer) return
    await this.consumer.disconnect().catch((err: unknown) => {
      console.error('[RouteFlow/kafka] Error during disconnect:', err)
    })
    this.consumer = null
    this.listeners.clear()
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) this.listeners.set(table, new Set())
    this.listeners.get(table)!.add(callback)
    return () => this.listeners.get(table)?.delete(callback)
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Maximum accepted Kafka message size (10 MiB). Larger messages are dropped. */
  private static readonly MAX_MESSAGE_BYTES = 10 * 1024 * 1024

  private async handleMessage(topic: string, value: Buffer | null): Promise<void> {
    if (value && value.byteLength > KafkaAdapter.MAX_MESSAGE_BYTES) {
      console.warn(`[RouteFlow/kafka] Dropping oversized message on topic "${topic}" (${value.byteLength} bytes > ${KafkaAdapter.MAX_MESSAGE_BYTES})`)
      return
    }
    const rawStr = value?.toString() ?? null

    let parsed: (Pick<ChangeEvent, 'operation'> & Partial<Pick<ChangeEvent, 'newRow' | 'oldRow'>>) | null

    if (this.options.parseMessage) {
      parsed = this.options.parseMessage(topic, rawStr)
    } else {
      try {
        parsed = rawStr ? (JSON.parse(rawStr) as typeof parsed) : null
      } catch {
        console.error(`[RouteFlow/kafka] Failed to parse message on topic "${topic}":`, rawStr)
        return
      }
    }

    if (!parsed || !isValidOperation(parsed.operation)) {
      console.warn(`[RouteFlow/kafka] Skipping message on topic "${topic}": missing or invalid "operation" field.`)
      return
    }

    const event: ChangeEvent = {
      table: topic,
      operation: parsed.operation,
      newRow: parsed.newRow ?? null,
      oldRow: parsed.oldRow ?? null,
      timestamp: Date.now(),
    }

    const cbs = this.listeners.get(topic)
    if (!cbs) return

    for (const cb of cbs) {
      try {
        cb(event)
      } catch (err) {
        console.error(`[RouteFlow/kafka] Listener error on topic "${topic}":`, err)
      }
    }
  }
}

function isValidOperation(op: unknown): op is ChangeEvent['operation'] {
  return op === 'INSERT' || op === 'UPDATE' || op === 'DELETE'
}
