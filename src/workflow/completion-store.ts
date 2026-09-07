/** Safely mirrors successful task completion into the editable workflow YAML. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ResolvedTask } from '../types/workflow.js';

export interface CompletionMetadata { completedAt: string; runId: string }

export class WorkflowCompletionStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly configPath: string) {}

  async markCompleted(task: ResolvedTask, metadata: CompletionMetadata): Promise<void> {
    await this.enqueue(() => this.update(task, metadata));
  }

  async clear(task: ResolvedTask): Promise<void> {
    await this.enqueue(() => this.update(task));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.pending.then(operation);
    this.pending = current.catch(() => undefined);
    return current;
  }

  private async update(task: ResolvedTask, metadata?: CompletionMetadata): Promise<void> {
    const text = await fs.readFile(this.configPath, 'utf8');
    const document = YAML.parseDocument(text, { prettyErrors: true });
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('; '));
    const tasks = document.get('tasks', true) as any;
    if (!YAML.isSeq(tasks)) throw new Error('workflow has no tasks sequence');
    const source = tasks.items.find((node: any) => YAML.isMap(node) && node.get('id') === task.sourceId) as any;
    if (!source) throw new Error(`source task "${task.sourceId}" no longer exists`);
    if (task.id === task.sourceId) {
      if (metadata) {
        source.set('state', 'completed');
        source.set('completion', metadata);
      } else {
        source.delete('state');
        source.delete('completion');
      }
    } else {
      const completion = (source.get('completion', true) as any) ?? new YAML.YAMLMap();
      let children = completion.get('tasks', true) as any;
      if (!children) { children = new YAML.YAMLMap(); completion.set('tasks', children); }
      if (metadata) children.set(task.id, metadata);
      else children.delete(task.id);
      source.set('completion', completion);
    }
    const temp = path.join(path.dirname(this.configPath), `.${path.basename(this.configPath)}.cao-${process.pid}.tmp`);
    await fs.writeFile(temp, String(document), 'utf8');
    await fs.rename(temp, this.configPath);
  }
}
