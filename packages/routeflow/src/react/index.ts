/**
 * RouteFlow React integration.
 *
 * Works with React 18+ and Next.js 13+ App Router.
 * In Next.js, add `'use client'` to any component that calls `useReactive`.
 *
 * @example — with provider (recommended for shared connections)
 * ```tsx
 * // layout.tsx
 * import { RouteFlowProvider } from 'routeflow-api/react'
 *
 * export default function Layout({ children }: { children: React.ReactNode }) {
 *   return (
 *     <RouteFlowProvider baseUrl="http://localhost:3000">
 *       {children}
 *     </RouteFlowProvider>
 *   )
 * }
 *
 * // ItemList.tsx
 * 'use client'
 * import { useReactive } from 'routeflow-api/react'
 *
 * export function ItemList() {
 *   const { data: items = [], loading } = useReactive<Item[]>('/items/live')
 *   if (loading) return <p>Loading…</p>
 *   return <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>
 * }
 * ```
 *
 * @example — standalone (no provider required)
 * ```tsx
 * 'use client'
 * import { useReactive } from 'routeflow-api/react'
 *
 * export function ItemList() {
 *   const { data, loading } = useReactive<Item[]>('/items/live', {
 *     baseUrl: 'http://localhost:3000',
 *   })
 *   ...
 * }
 * ```
 */

import {
  useState,
  useEffect,
  useRef,
  createContext,
  useContext,
  createElement,
  type ReactNode,
} from 'react'
import { createClient } from '../client/index.js'
import type { ClientOptions, ConnectionState } from '../client/index.js'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface RouteFlowContextValue {
  baseUrl: string
  options?: Omit<ClientOptions, 'baseUrl'>
}

const RouteFlowContext = createContext<RouteFlowContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface RouteFlowProviderProps extends Omit<ClientOptions, 'baseUrl'> {
  baseUrl: string
  children: ReactNode
}

/**
 * Optional context provider that shares a single `ReactiveClient` across
 * the component tree, preventing multiple WebSocket connections.
 *
 * Place at the root of your app (e.g. `_app.tsx` or `layout.tsx`).
 */
export function RouteFlowProvider({ baseUrl, children, ...options }: RouteFlowProviderProps): ReturnType<typeof createElement> {
  return createElement(
    RouteFlowContext.Provider,
    { value: { baseUrl, options: options as Omit<ClientOptions, 'baseUrl'> } },
    children,
  )
}

// ---------------------------------------------------------------------------
// useReactive
// ---------------------------------------------------------------------------

export interface UseReactiveOptions {
  /** Base URL of the RouteFlow server. Required when used without a provider. */
  baseUrl?: string
  /** Optional query parameters forwarded to the reactive endpoint. */
  query?: Record<string, string>
  /** Transport: `'websocket'` (default) or `'sse'`. Must match the server. */
  transport?: 'websocket' | 'sse'
  /** Called on server-side subscription errors. */
  onError?: (err: { code: string; message: string }) => void
}

export interface UseReactiveResult<T> {
  /** Latest data pushed by the server. `undefined` until the first push. */
  data: T | undefined
  /** `true` until the first push has been received. */
  loading: boolean
  /** Last error from the server, or `null`. */
  error: { code: string; message: string } | null
  /** Current WebSocket connection state. */
  connectionState: ConnectionState
}

/**
 * Subscribe to a reactive endpoint and receive live updates.
 *
 * - Renders with `loading: true` on SSR (Next.js compatible — `useEffect`
 *   only runs on the client, so no WebSocket is opened during server rendering).
 * - Automatically reconnects when the WebSocket drops.
 * - Cleans up the subscription on unmount.
 *
 * @param path    - The reactive path, e.g. `'/items/live'`
 * @param options - `baseUrl` is required when used outside of `<RouteFlowProvider>`.
 */
export function useReactive<T>(
  path: string,
  options?: UseReactiveOptions,
): UseReactiveResult<T> {
  const ctx = useContext(RouteFlowContext)
  const baseUrl = options?.baseUrl ?? ctx?.baseUrl

  const [data, setData]               = useState<T | undefined>(undefined)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<{ code: string; message: string } | null>(null)
  const [connectionState, setConnState] = useState<ConnectionState>('connecting')

  const clientRef    = useRef<ReturnType<typeof createClient> | null>(null)
  const onErrorRef   = useRef(options?.onError)
  onErrorRef.current = options?.onError

  const queryKey = JSON.stringify(options?.query ?? null)
  const transport = options?.transport ?? ctx?.options?.transport

  useEffect(() => {
    if (!baseUrl) {
      console.error('[RouteFlow] useReactive: no baseUrl provided. Pass options.baseUrl or use <RouteFlowProvider>.')
      return
    }

    if (!clientRef.current) {
      clientRef.current = createClient(baseUrl, {
        ...ctx?.options,
        transport,
        onError: (err) => onErrorRef.current?.(err),
      })
    }

    const client = clientRef.current
    const offState = client.onConnectionStateChange(setConnState)

    const unsub = client.subscribe<T>(
      path,
      (newData: T) => {
        setData(newData)
        setLoading(false)
        setError(null)
      },
      {
        query: options?.query,
        onError: (err: { code: string; message: string }) => {
          setError(err)
          setLoading(false)
          onErrorRef.current?.(err)
        },
      },
    )

    return () => {
      unsub()
      offState()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, baseUrl, transport, queryKey])

  // Destroy the standalone client on final unmount.
  // Provider-managed clients are destroyed by the provider.
  useEffect(() => {
    return () => {
      if (!ctx && clientRef.current) {
        clientRef.current.destroy()
        clientRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, loading, error, connectionState }
}

// ---------------------------------------------------------------------------
// useRouteFlow — HTTP mutation helpers
// ---------------------------------------------------------------------------

/**
 * Access RouteFlow HTTP methods (`get`, `post`, `put`, `patch`, `del`) for
 * mutations. Uses the provider's client when available.
 *
 * @example
 * ```tsx
 * function AddItem() {
 *   const rf = useRouteFlow({ baseUrl: 'http://localhost:3000' })
 *   return (
 *     <button onClick={() => rf.post('/items', { name: 'New item' })}>
 *       Add
 *     </button>
 *   )
 * }
 * ```
 */
export function useRouteFlow(opts?: { baseUrl?: string; transport?: 'websocket' | 'sse' }) {
  const ctx     = useContext(RouteFlowContext)
  const baseUrl = opts?.baseUrl ?? ctx?.baseUrl

  if (!baseUrl) {
    throw new Error(
      '[RouteFlow] useRouteFlow: no baseUrl provided. Pass opts.baseUrl or use <RouteFlowProvider>.',
    )
  }

  const clientRef = useRef<ReturnType<typeof createClient> | null>(null)
  if (!clientRef.current) {
    clientRef.current = createClient(baseUrl, { ...ctx?.options, ...opts })
  }
  const client = clientRef.current

  return {
    get:   <T>(path: string, query?: Record<string, string>) => client.get<T>(path, query),
    post:  <T>(path: string, body?: unknown) => client.post<T>(path, body),
    put:   <T>(path: string, body?: unknown) => client.put<T>(path, body),
    patch: <T>(path: string, body?: unknown) => client.patch<T>(path, body),
    del:   <T>(path: string) => client.del<T>(path),
  }
}
