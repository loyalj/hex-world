/**
 * A listener for one event type. The payload type comes from the emitter's
 * event map, so `on('cellClick', e => …)` types `e` without an annotation.
 */
export type EventListener<T> = (payload: T) => void;

/** Returned by {@link Emitter.on} and {@link Emitter.once} — call to unsubscribe. */
export type Unsubscribe = () => void;

/** Internal marker: `once` wraps its listener, and `off` needs to find the original. */
interface WrappedListener<T> {
  (payload: T): void;
  /** The listener the caller passed to `once`. */
  __source?: unknown;
}

/**
 * A small typed event emitter, generic over an event map — an interface whose
 * keys are event names and whose values are that event's payload type:
 *
 * ```ts
 * interface MyEvents {
 *   ready:  { at: number };
 *   failed: Error;
 * }
 * const events = new Emitter<MyEvents>();
 * events.on('ready', e => console.log(e.at));   // e is { at: number }
 * events.emit('failed', new Error('nope'));
 * ```
 *
 * Two behaviours matter for anything driven from a render loop:
 *
 * - **Dispatch is snapshotted.** `emit` iterates a copy of the listener set, so
 *   a listener that subscribes or unsubscribes while the event is being
 *   delivered doesn't change who receives *this* event. Without it, a handler
 *   that removes itself would make the iterator skip the next listener.
 * - **A throwing listener doesn't stop the others.** One consumer's bug should
 *   not halt chunk streaming or drop the remaining subscribers' events. The
 *   error is still surfaced, not swallowed: by default it is rethrown from a
 *   microtask, which reaches `window.onerror` / `unhandledException` with its
 *   original stack. Set {@link onError} to route it somewhere else instead.
 */
export class Emitter<EventMap> {
  /** Listener sets per event type. Absent key = no listeners, so `emit` is a single Map lookup. */
  private readonly listeners = new Map<keyof EventMap, Set<WrappedListener<never>>>();

  /**
   * Called when a listener throws, instead of the default asynchronous rethrow.
   * Set this to log, count, or fail loudly in tests.
   */
  onError: ((error: unknown, type: keyof EventMap) => void) | null = null;

  /**
   * Subscribe to an event. Returns an unsubscribe function, so a consumer can
   * hold one disposer rather than keeping the listener reference around:
   *
   * ```ts
   * const off = world.events.on('cellClick', onClick);
   * // later
   * off();
   * ```
   *
   * Adding the same listener twice is a no-op — listeners are a set, so an
   * event is never delivered to the same function twice.
   */
  on<K extends keyof EventMap>(type: K, listener: EventListener<EventMap[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as WrappedListener<never>);
    return () => this.off(type, listener);
  }

  /** Subscribe until the next time this event fires, then unsubscribe automatically. */
  once<K extends keyof EventMap>(type: K, listener: EventListener<EventMap[K]>): Unsubscribe {
    const wrapper: WrappedListener<EventMap[K]> = (payload) => {
      this.off(type, wrapper as EventListener<EventMap[K]>);
      listener(payload);
    };
    // Lets `off(type, original)` cancel a `once` subscription without the
    // caller having to keep the unsubscribe function.
    wrapper.__source = listener;
    return this.on(type, wrapper as EventListener<EventMap[K]>);
  }

  /**
   * Unsubscribe a listener. Accepts either the function passed to {@link on}
   * or the one passed to {@link once} (its wrapper is matched for you).
   */
  off<K extends keyof EventMap>(type: K, listener: EventListener<EventMap[K]>): void {
    const set = this.listeners.get(type);
    if (!set) return;

    if (!set.delete(listener as WrappedListener<never>)) {
      for (const candidate of set) {
        if ((candidate as WrappedListener<never>).__source === listener) {
          set.delete(candidate);
          break;
        }
      }
    }
    if (set.size === 0) this.listeners.delete(type);
  }

  /**
   * Deliver an event to every current listener. Returns true if anyone was
   * listening — useful to skip building an expensive payload:
   *
   * ```ts
   * if (events.listenerCount('chunkLoaded') > 0) events.emit('chunkLoaded', buildPayload());
   * ```
   */
  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): boolean {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return false;

    // Copy first: a listener may unsubscribe itself (or others) during dispatch.
    for (const listener of [...set]) {
      try {
        (listener as EventListener<EventMap[K]>)(payload);
      } catch (error) {
        if (this.onError) this.onError(error, type);
        else queueMicrotask(() => { throw error; });
      }
    }
    return true;
  }

  /** How many listeners are subscribed to an event — 0 if none. */
  listenerCount<K extends keyof EventMap>(type: K): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Drop every listener for one event type, or (with no argument) for all of them. */
  removeAllListeners<K extends keyof EventMap>(type?: K): void {
    if (type === undefined) this.listeners.clear();
    else this.listeners.delete(type);
  }
}
