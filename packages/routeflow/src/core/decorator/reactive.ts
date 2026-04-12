import type { ReactiveOptions } from '../types.js'

/** Symbol key used to store @Reactive metadata on a method. */
export const REACTIVE_METADATA = Symbol('reactive-api:reactive')

/**
 * Function-keyed store for TC39 (new-style) decorator compat.
 */
export const reactiveFnStore = new WeakMap<object, ReactiveOptions>()

/**
 * Marks a route handler as reactive — when the watched table(s) change,
 * the handler is re-executed and the result is pushed to all subscribed clients.
 *
 * Must be used together with @Route.
 * Works with both TypeScript legacy decorators and TC39 Stage 3 decorators.
 *
 * @param options - Reactive configuration (watch, filter, debounce)
 */
export function Reactive(options: ReactiveOptions) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey: any): void {
    if (typeof target === 'function') {
      // TC39 decorator: target is the method function itself
      reactiveFnStore.set(target, options)
    } else if (typeof propertyKey === 'string') {
      // Legacy decorator: target is the prototype, propertyKey is method name
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const fn = target[propertyKey] as object
      if (fn) reactiveFnStore.set(fn, options)
      if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
        Reflect.defineMetadata(REACTIVE_METADATA, options, target, propertyKey)
      }
    }
  }
}
