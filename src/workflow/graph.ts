/** DAG utilities over resolved tasks: cycle detection, topological order, Kahn layers, closures. */

export interface GraphNode {
  id: string;
  dependsOn: string[];
  docIndex: number;
}

export interface CycleError {
  cycle: string[];
}

export class TaskGraph {
  readonly ids: string[];
  private readonly deps = new Map<string, string[]>();
  private readonly dependents = new Map<string, string[]>();
  private readonly index = new Map<string, number>();

  constructor(nodes: GraphNode[]) {
    const sorted = [...nodes].sort((a, b) => a.docIndex - b.docIndex);
    this.ids = sorted.map((n) => n.id);
    for (const n of sorted) {
      this.deps.set(n.id, [...n.dependsOn]);
      this.index.set(n.id, n.docIndex);
      if (!this.dependents.has(n.id)) this.dependents.set(n.id, []);
    }
    for (const n of sorted) {
      for (const d of n.dependsOn) {
        if (!this.dependents.has(d)) this.dependents.set(d, []);
        this.dependents.get(d)!.push(n.id);
      }
    }
  }

  has(id: string): boolean {
    return this.deps.has(id);
  }

  dependenciesOf(id: string): string[] {
    return this.deps.get(id) ?? [];
  }

  dependentsOf(id: string): string[] {
    return this.dependents.get(id) ?? [];
  }

  /** Returns the first cycle found (as a path), or null. */
  findCycle(): string[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      color.set(id, GRAY);
      stack.push(id);
      for (const d of this.dependenciesOf(id)) {
        if (!this.deps.has(d)) continue;
        const c = color.get(d) ?? WHITE;
        if (c === GRAY) {
          const start = stack.indexOf(d);
          return [...stack.slice(start), d];
        }
        if (c === WHITE) {
          const found = visit(d);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(id, BLACK);
      return null;
    };
    for (const id of this.ids) {
      if ((color.get(id) ?? WHITE) === WHITE) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /** Kahn's algorithm; ties broken by document order. Throws if a cycle exists. */
  layers(): string[][] {
    const indeg = new Map<string, number>();
    for (const id of this.ids) indeg.set(id, this.dependenciesOf(id).filter((d) => this.deps.has(d)).length);
    let frontier = this.ids.filter((id) => indeg.get(id) === 0);
    const layers: string[][] = [];
    let seen = 0;
    while (frontier.length > 0) {
      layers.push(frontier);
      seen += frontier.length;
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of this.dependentsOf(id)) {
          const v = (indeg.get(dep) ?? 0) - 1;
          indeg.set(dep, v);
          if (v === 0) next.push(dep);
        }
      }
      frontier = next.sort((a, b) => (this.index.get(a) ?? 0) - (this.index.get(b) ?? 0));
    }
    if (seen !== this.ids.length) {
      const cycle = this.findCycle();
      throw new Error(`Circular dependency detected: ${(cycle ?? []).join(' -> ')}`);
    }
    return layers;
  }

  topologicalOrder(): string[] {
    return this.layers().flat();
  }

  /** All transitive dependencies of `id` (excluding itself). */
  ancestors(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [...this.dependenciesOf(id)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      stack.push(...this.dependenciesOf(cur));
    }
    return out;
  }

  /** All transitive dependents of `id` (excluding itself). */
  descendants(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [...this.dependentsOf(id)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      stack.push(...this.dependentsOf(cur));
    }
    return out;
  }
}
