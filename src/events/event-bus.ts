import type { WorkflowEvent, WorkflowEventBody, WorkflowEventType, EventOf } from '../types/events.js';

type AnyHandler = (event: WorkflowEvent) => void;

export interface EventBus {
  emit(body: WorkflowEventBody): WorkflowEvent;
  on<T extends WorkflowEventType>(type: T, handler: (event: EventOf<T>) => void): () => void;
  onAny(handler: AnyHandler): () => void;
  readonly seq: number;
}

/**
 * Typed, synchronous event bus. Handler errors are isolated so presentation or persistence bugs
 * can never break orchestration.
 */
export class WorkflowEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<AnyHandler>>();
  private readonly anyHandlers = new Set<AnyHandler>();
  private counter: number;
  private readonly onError: (err: unknown, event: WorkflowEvent) => void;

  constructor(
    private readonly runId: string,
    startSeq = 0,
    onError?: (err: unknown, event: WorkflowEvent) => void,
  ) {
    this.counter = startSeq;
    this.onError = onError ?? (() => undefined);
  }

  get seq(): number {
    return this.counter;
  }

  emit(body: WorkflowEventBody): WorkflowEvent {
    this.counter += 1;
    const event = { seq: this.counter, ts: new Date().toISOString(), runId: this.runId, ...body } as WorkflowEvent;
    const specific = this.handlers.get(body.type);
    if (specific) for (const h of [...specific]) this.safe(h, event);
    for (const h of [...this.anyHandlers]) this.safe(h, event);
    return event;
  }

  on<T extends WorkflowEventType>(type: T, handler: (event: EventOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = handler as unknown as AnyHandler;
    set.add(h);
    return () => set?.delete(h);
  }

  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  private safe(handler: AnyHandler, event: WorkflowEvent): void {
    try {
      handler(event);
    } catch (err) {
      this.onError(err, event);
    }
  }
}
