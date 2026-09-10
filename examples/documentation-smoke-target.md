# CAO Documentation Smoke Target

CAO runs agent tasks defined in a workflow file.

## Run a workflow

```bash
cao run workflow.yaml
```

## Validate before running

```bash
cao validate workflow.yaml
```

Checks the workflow file for errors before running it.

```bash
cao run workflow.yaml --dry-run
```

Previews the workflow run without executing agent tasks.

## Inspect a run

```bash
cao status <run-id>
```

Shows the current state of a run and its tasks.

```bash
cao logs <run-id> <task-id>
```

Prints the output logs for a specific task in a run.
