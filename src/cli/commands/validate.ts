import { prepareWorkflow, detectRunnersForWorkflow } from '../app.js';
import { formatDiagnostics } from '../../workflow/validator.js';
import { renderExecutionPlan } from '../../workflow/plan.js';
import { errorLine, okLine } from '../../util/marks.js';
import { resolveWorkflowPath } from '../util.js';
import { formatAgents } from '../render/plain.js';

export interface ValidateOptions {
  repository?: string;
  json?: boolean;
  verbose?: boolean;
}

export async function validateCommand(configPath: string | undefined, opts: ValidateOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const prepared = await prepareWorkflow(await resolveWorkflowPath(configPath), { repository: opts.repository });
  const { workflow, diagnostics, validation, layers } = prepared;
  const runners = await detectRunnersForWorkflow(workflow);
  if (opts.json) {
    out(
      JSON.stringify(
        {
          ok: validation.ok,
          name: workflow.name,
          repository: workflow.repositoryRoot,
          runners,
          diagnostics,
          tasks: workflow.tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn, implicitDeps: t.implicitDeps, type: t.type, runner: t.runner, agent: t.agent, model: t.model, effort: t.effort })),
          layers,
        },
        null,
        2,
      ),
    );
    return validation.ok ? 0 : 2;
  }
  out(`Workflow:    ${workflow.name}`);
  out(`Config:      ${workflow.configPath}`);
  out(`Repository:  ${workflow.repositoryRoot}${workflow.gitRoot ? '' : '  (not a git repository)'}`);
  out(`Tasks:       ${workflow.tasks.length}`);
  out(`Agents:      ${formatAgents(runners)}`);
  out('');
  if (diagnostics.length) {
    out(formatDiagnostics(diagnostics));
    out('');
  }
  if (validation.ok) {
    out('Execution Plan');
    out('');
    out(renderExecutionPlan(workflow, layers, { verbose: true }));
    out('');
    out(okLine(`Workflow is valid${diagnostics.length ? ` (${diagnostics.length} warning(s))` : ''}`));
    return 0;
  }
  out(errorLine(`Workflow is invalid (${diagnostics.filter((d) => d.level === 'error').length} error(s))`));
  return 2;
}
