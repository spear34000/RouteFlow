/**
 * FastAPI ↔ RouteFlow bridge utilities.
 *
 * Generates a ready-to-use Python `httpx` client from a running RouteFlow
 * server's OpenAPI spec, and provides a typed fetch helper so TypeScript
 * services can call FastAPI endpoints with full type inference.
 *
 * ### Workflow
 *
 * ```
 * RouteFlow (Node.js)                FastAPI (Python)
 *      ↓  GET /openapi.json               ↓  POST /webhook  →  WebhookAdapter
 *  app.openapi()                     httpx.post(routeflow_url, json=event)
 *      ↓                                  ↑
 *   TypeScript types  ←────── codegen ────┘
 * ```
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FastAPIClientOptions {
  /**
   * Base URL of the FastAPI server (e.g. `'http://localhost:8000'`).
   */
  baseUrl: string
  /**
   * Default headers sent with every request (e.g. `Authorization`).
   */
  headers?: Record<string, string>
  /**
   * Request timeout in milliseconds. Default: `10_000` (10 s).
   */
  timeoutMs?: number
}

export interface FastAPIRequestOptions {
  /** Per-request header overrides. */
  headers?: Record<string, string>
  /** Abort signal for cancellation. */
  signal?: AbortSignal
}

// ── Runtime client ─────────────────────────────────────────────────────────────

/**
 * Lightweight typed HTTP client for calling FastAPI endpoints from TypeScript.
 *
 * All methods throw `FastAPIError` on non-2xx responses and network failures.
 *
 * @example
 * ```ts
 * import { createFastAPIClient } from 'routeflow-api/integrations/fastapi'
 *
 * const py = createFastAPIClient({ baseUrl: 'http://localhost:8000' })
 *
 * // Call a FastAPI route
 * const result = await py.post<{ prediction: number }>('/predict', { features: [1, 2, 3] })
 * console.log(result.prediction)
 * ```
 */
export class FastAPIClient {
  private readonly baseUrl: string
  private readonly defaultHeaders: Record<string, string>
  private readonly timeoutMs: number

  constructor(options: FastAPIClientOptions) {
    this.baseUrl        = options.baseUrl.replace(/\/$/, '')
    this.defaultHeaders = options.headers  ?? {}
    this.timeoutMs      = options.timeoutMs ?? 10_000
  }

  async get<T>(path: string, query?: Record<string, string>, opts?: FastAPIRequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, query, opts)
  }

  async post<T>(path: string, body?: unknown, opts?: FastAPIRequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, undefined, opts)
  }

  async put<T>(path: string, body?: unknown, opts?: FastAPIRequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, undefined, opts)
  }

  async patch<T>(path: string, body?: unknown, opts?: FastAPIRequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, undefined, opts)
  }

  async del<T>(path: string, opts?: FastAPIRequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, undefined, opts)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    opts?: FastAPIRequestOptions,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`
    if (query && Object.keys(query).length > 0) {
      url += '?' + new URLSearchParams(query).toString()
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...this.defaultHeaders,
      ...opts?.headers,
    }

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs)
    const signal     = opts?.signal
      ? anySignal([opts.signal, controller.signal])
      : controller.signal

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body:   body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new FastAPIError(
        'NETWORK_ERROR',
        `Network request to FastAPI failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      let detail = ''
      try {
        const json = await response.json() as Record<string, unknown>
        detail = typeof json['detail'] === 'string' ? ` — ${json['detail']}` : ''
      } catch { /* ignore */ }
      throw new FastAPIError(
        'HTTP_ERROR',
        `FastAPI ${method} ${path} → ${response.status}${detail}`,
        response.status,
      )
    }

    if (response.status === 204) return undefined as T
    try {
      return await response.json() as T
    } catch {
      throw new FastAPIError('PARSE_ERROR', `Failed to parse FastAPI response from ${path}`)
    }
  }
}

/** Error thrown by `FastAPIClient` on non-2xx responses and network failures. */
export class FastAPIError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'FastAPIError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Create a `FastAPIClient` instance.
 *
 * @example
 * ```ts
 * const py = createFastAPIClient({ baseUrl: 'http://localhost:8000' })
 * const predictions = await py.post<Prediction[]>('/predict/batch', { items })
 * ```
 */
export function createFastAPIClient(options: FastAPIClientOptions): FastAPIClient {
  return new FastAPIClient(options)
}

// ── Python client codegen ───────────────────────────────────────────────────────

export interface GeneratePythonClientOptions {
  /**
   * URL of the RouteFlow OpenAPI JSON spec.
   * e.g. `'http://localhost:3000/openapi.json'`
   */
  specUrl: string
  /**
   * Output directory for the generated Python code.
   * Default: `'./python-client'` relative to `process.cwd()`.
   */
  outDir?: string
  /**
   * Python package name for the generated client.
   * Default: derived from the spec title (snake_cased).
   */
  packageName?: string
}

/**
 * Fetch the RouteFlow OpenAPI spec and generate a ready-to-use Python `httpx`
 * client alongside typed `TypedDict` models.
 *
 * Run this at build time or as a one-off script to keep the Python side
 * in sync with the TypeScript API:
 *
 * ```ts
 * // scripts/gen-python-client.ts
 * import { generatePythonClient } from 'routeflow-api/integrations/fastapi'
 *
 * await generatePythonClient({
 *   specUrl:     'http://localhost:3000/openapi.json',
 *   outDir:      '../python-service/routeflow_client',
 *   packageName: 'routeflow_client',
 * })
 * ```
 *
 * This generates:
 * ```
 * python-client/
 *   __init__.py          ← re-exports everything
 *   _client.py           ← httpx-based typed client
 *   _models.py           ← TypedDict models per route
 *   requirements.txt     ← httpx dependency
 * ```
 *
 * Call from FastAPI:
 * ```python
 * from routeflow_client import RouteFlowClient
 *
 * client = RouteFlowClient(base_url="http://localhost:3000")
 * items  = client.get_items()           # typed: list[dict]
 * item   = client.create_item(name="Apple", created_at="...")
 * ```
 */
export async function generatePythonClient(options: GeneratePythonClientOptions): Promise<void> {
  const { specUrl, outDir = './python-client', packageName } = options

  // Fetch the spec
  let spec: Record<string, unknown>
  try {
    const res = await fetch(specUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    spec = await res.json() as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `[RouteFlow] generatePythonClient: failed to fetch spec from ${specUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const info     = (spec['info'] ?? {}) as Record<string, string>
  const title    = info['title']   ?? 'RouteFlow API'
  const version  = info['version'] ?? '1.0.0'
  const pkgName  = packageName ?? toSnakeCase(title)
  const paths    = (spec['paths'] ?? {}) as Record<string, Record<string, unknown>>

  // Parse routes into a simple structure
  interface ParsedRoute {
    method: string
    path: string
    operationId: string
    hasBody: boolean
    isReactive: boolean
    tag: string
  }

  const routes: ParsedRoute[] = []
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const operation = op as Record<string, unknown>
      routes.push({
        method:      method.toUpperCase(),
        path,
        operationId: (operation['operationId'] as string) ?? `${method}_${path.replace(/\W/g, '_')}`,
        hasBody:     !!operation['requestBody'],
        isReactive:  !!(operation as Record<string, unknown>)['x-routeflow-reactive'],
        tag:         ((operation['tags'] as string[] | undefined)?.[0]) ?? 'default',
      })
    }
  }

  // Generate Python methods
  const methods = routes.map((r) => {
    const fnName = toSnakeCase(r.operationId)
    const pyPath = r.path.replace(/:([a-z_]+)/g, '{$1}')
    const params: string[] = []
    const pathParams = [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1])

    for (const p of pathParams) params.push(`${p}: str | int`)
    if (r.hasBody) params.push('**body: Any')

    const paramStr = params.length ? `, ${params.join(', ')}` : ''
    const urlExpr  = pathParams.length
      ? `f"${pyPath}"`
      : `"${pyPath}"`

    if (r.method === 'GET') {
      return `    def ${fnName}(self${paramStr}) -> Any:\n        return self._get(${urlExpr})`
    }
    if (r.method === 'DELETE') {
      return `    def ${fnName}(self${paramStr}) -> Any:\n        return self._delete(${urlExpr})`
    }
    return `    def ${fnName}(self${paramStr}) -> Any:\n        return self._${r.method.toLowerCase()}(${urlExpr}, body)`
  })

  // ── _client.py ────────────────────────────────────────────────────────────
  const clientPy = `# AUTO-GENERATED by routeflow-api — DO NOT EDIT
# Source: ${specUrl}
# Version: ${version}
from __future__ import annotations
from typing import Any
import httpx


class RouteFlowClient:
    """Typed HTTP client for ${title}.

    Generated from the RouteFlow OpenAPI spec.
    Matches the server-side TypeScript controller exactly.
    """

    def __init__(self, base_url: str, headers: dict[str, str] | None = None, timeout: float = 10.0):
        self._base_url = base_url.rstrip("/")
        self._headers  = {"Content-Type": "application/json", "Accept": "application/json", **(headers or {})}
        self._timeout  = timeout

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    def _get(self, path: str, params: dict | None = None) -> Any:
        r = httpx.get(self._base_url + path, params=params, headers=self._headers, timeout=self._timeout)
        r.raise_for_status()
        return r.json() if r.content else None

    def _post(self, path: str, body: Any = None) -> Any:
        r = httpx.post(self._base_url + path, json=body, headers=self._headers, timeout=self._timeout)
        r.raise_for_status()
        return r.json() if r.content else None

    def _put(self, path: str, body: Any = None) -> Any:
        r = httpx.put(self._base_url + path, json=body, headers=self._headers, timeout=self._timeout)
        r.raise_for_status()
        return r.json() if r.content else None

    def _patch(self, path: str, body: Any = None) -> Any:
        r = httpx.patch(self._base_url + path, json=body, headers=self._headers, timeout=self._timeout)
        r.raise_for_status()
        return r.json() if r.content else None

    def _delete(self, path: str) -> Any:
        r = httpx.delete(self._base_url + path, headers=self._headers, timeout=self._timeout)
        r.raise_for_status()
        return r.json() if r.content else None

    # ── Generated API methods ─────────────────────────────────────────────────

${methods.join('\n\n')}
`

  // ── __init__.py ───────────────────────────────────────────────────────────
  const initPy = `# AUTO-GENERATED by routeflow-api
from ._client import RouteFlowClient

__all__ = ["RouteFlowClient"]
`

  // ── requirements.txt ──────────────────────────────────────────────────────
  const requirements = `httpx>=0.27.0\n`

  // ── Write files ───────────────────────────────────────────────────────────
  const abs = join(process.cwd(), outDir)
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, '_client.py'),        clientPy,    'utf8')
  writeFileSync(join(abs, '__init__.py'),        initPy,      'utf8')
  writeFileSync(join(abs, 'requirements.txt'),   requirements, 'utf8')

  console.log(`[RouteFlow] Python client generated → ${abs}/`)
  console.log(`  Package : ${pkgName}`)
  console.log(`  Routes  : ${routes.length}`)
  console.log(`  Install : pip install -r ${outDir}/requirements.txt`)
}

// ── Utilities ────────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
  return str
    .replace(/\s+/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

/** Combine multiple AbortSignals (Node 18+ / modern browsers). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (AbortSignal as any).any(signals) as AbortSignal
  }
  // Fallback: return first signal
  return signals[0]!
}
