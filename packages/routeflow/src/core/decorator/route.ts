import type { HttpMethod, RouteMetadata } from '../types.js'

/** Symbol key used to store @Route metadata on a method. */
export const ROUTE_METADATA = Symbol('reactive-api:route')

/**
 * Function-keyed store for TC39 (new-style) decorator compat.
 * Legacy decorators use Reflect.defineMetadata; TC39 decorators store here.
 */
export const routeFnStore = new WeakMap<object, RouteMetadata>()

/**
 * Registers a class method as an HTTP endpoint.
 *
 * Works with both TypeScript legacy decorators (experimentalDecorators) and
 * TC39 Stage 3 decorators (as used by esbuild/tsx without legacy flag).
 *
 * @param method - HTTP verb
 * @param path   - Route path, may include Fastify-style params (e.g. '/users/:id')
 */
export function Route(method: HttpMethod, path: string) {
  const metadata: RouteMetadata = { method, path }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey: any): void {
    if (typeof target === 'function') {
      // TC39 decorator: target is the method function itself
      routeFnStore.set(target, metadata)
    } else if (typeof propertyKey === 'string') {
      // Legacy decorator: target is the prototype, propertyKey is method name
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const fn = target[propertyKey] as object
      if (fn) routeFnStore.set(fn, metadata)
      // Reflect.defineMetadata may not be available in all environments (e.g. vitest without reflect-metadata)
      if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
        Reflect.defineMetadata(ROUTE_METADATA, metadata, target, propertyKey)
      }
    }
  }
}
