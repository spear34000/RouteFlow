import type { HttpMethod, RouteMetadata } from '../types.js'

// ── HTTP method shorthand decorators ─────────────────────────────────────────
//
// These are simple aliases for @Route — use whichever style you prefer.
//
// @Get('/items')    ≡  @Route('GET',    '/items')
// @Post('/items')   ≡  @Route('POST',   '/items')
// @Put('/items/:id')≡  @Route('PUT',    '/items/:id')
// @Patch('/items/:id')≡@Route('PATCH',  '/items/:id')
// @Delete('/items/:id')≡@Route('DELETE','/items/:id')

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

/** Shorthand for `@Route('GET', path)`. */
export const Get    = (path: string) => Route('GET',    path)
/** Shorthand for `@Route('POST', path)`. */
export const Post   = (path: string) => Route('POST',   path)
/** Shorthand for `@Route('PUT', path)`. */
export const Put    = (path: string) => Route('PUT',    path)
/** Shorthand for `@Route('PATCH', path)`. */
export const Patch  = (path: string) => Route('PATCH',  path)
/** Shorthand for `@Route('DELETE', path)`. Named `Delete` because `delete` is a reserved keyword. */
export const Delete = (path: string) => Route('DELETE', path)
