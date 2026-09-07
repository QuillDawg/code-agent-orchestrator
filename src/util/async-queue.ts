/** Minimal unbounded async queue: producers push, a single consumer awaits next(). */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((value: T) => void) | null = null;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }

  get size(): number {
    return this.items.length;
  }
}

export class RingBuffer<T> {
  private readonly buf: T[] = [];
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  toArray(): T[] {
    return [...this.buf];
  }

  last(n: number): T[] {
    return this.buf.slice(Math.max(0, this.buf.length - n));
  }

  get length(): number {
    return this.buf.length;
  }
}

/** Simple async mutex keyed by string (used to serialize work on a shared working tree). */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.chains.set(key, chained);
    await previous;
    return () => {
      release();
      if (this.chains.get(key) === chained) this.chains.delete(key);
    };
  }
}
