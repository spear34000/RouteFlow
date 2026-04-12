import type { ChangeEvent } from '@spear340000/core'

export interface MongoChangeStreamDocument<TSchema = Record<string, unknown>> {
  operationType: 'insert' | 'update' | 'replace' | 'delete'
  fullDocument?: TSchema | null
  fullDocumentBeforeChange?: TSchema | null
  documentKey?: { _id?: unknown }
  ns?: {
    db?: string
    coll?: string
  }
}

export interface MongoChangeStreamLike<TSchema = Record<string, unknown>> {
  on(
    event: 'change',
    listener: (change: MongoChangeStreamDocument<TSchema>) => void,
  ): this
  on(event: 'error', listener: (error: Error) => void): this
  close(): Promise<void> | void
}

export interface MongoCollectionLike<TSchema = Record<string, unknown>> {
  watch(
    pipeline?: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): MongoChangeStreamLike<TSchema>
}

export interface MongoDatabaseLike {
  collection<TSchema = Record<string, unknown>>(name: string): MongoCollectionLike<TSchema>
}

export interface MongoAdapterOptions {
  db: MongoDatabaseLike
  watchOptions?: Record<string, unknown>
  onError?: (error: unknown, context: { collection: string }) => void
}

export interface MongoCollectionState {
  stream: MongoChangeStreamLike
  listeners: Set<(event: ChangeEvent) => void>
}
