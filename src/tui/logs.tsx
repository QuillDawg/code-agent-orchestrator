/**
 * `cao logs --follow` in a terminal: the shared transcript viewer fed from the run's files, so any task
 * (running or finished) can be opened and switched from another terminal.
 */
import React, { useEffect, useRef, useState } from 'react';
import { render, useApp, useStdout } from 'ink';
import path from 'node:path';
import type { FileRunStore } from '../persistence/run-store.js';
import type { WorkflowRun } from '../types/run.js';
import type { TranscriptEntry } from '../types/transcript.js';
import { parseTranscriptLine } from '../types/transcript.js';
import { followFile } from './follow.js';
import { readOlderEntries } from '../persistence/transcript-log.js';
import { TranscriptViewer, type ViewerTask } from './viewer.js';
import { taskDuration } from '../cli/util.js';

export interface LogsViewerOptions {
  store: FileRunStore;
  run: WorkflowRun;
  taskId: string;
  attempt?: number;
  /** Trailing lines loaded when opening a task. */
  lines: number;
  color: boolean;
  /** Start with thinking shown (`cao logs --thinking`). */
  thinking?: boolean;
}

function viewerTasks(run: WorkflowRun, live: Awaited<ReturnType<FileRunStore['readLive']>>): ViewerTask[] {
  return run.workflow.tasks.map((t) => {
    const st = run.tasks[t.id]!;
    const lt = live?.tasks[t.id];
    const a = st.currentAttempt !== undefined ? st.attempts.find((x) => x.number === st.currentAttempt) : st.attempts[st.attempts.length - 1];
    return {
      id: t.id,
      state: lt?.state ?? st.state,
      attempts: st.attempts.map((x) => x.number),
      elapsed: taskDuration(st),
      usage: lt?.usage ?? a?.usage ?? st.result?.usage,
      filesChanged: lt?.filesChanged ?? (a?.files ? Object.keys(a.files).length : st.result?.filesChanged.length || undefined),
      pending: (lt?.pendingInteraction ?? st.pendingInteraction)?.title,
    };
  });
}

function LogsApp(opts: LogsViewerOptions): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [run, setRun] = useState(opts.run);
  const [tasks, setTasks] = useState<ViewerTask[]>(() => viewerTasks(opts.run, null));
  const [taskId, setTaskId] = useState(opts.taskId);
  const [attempt, setAttempt] = useState<number | undefined>(opts.attempt);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const runRef = useRef(run);
  runRef.current = run;

  // Refresh the strip from disk once a second.
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      const fresh = await opts.store.loadRun(opts.run.runId).catch(() => runRef.current);
      const live = await opts.store.readLive(opts.run.runId).catch(() => null);
      if (stopped) return;
      setRun(fresh);
      setTasks(viewerTasks(fresh, live));
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [opts.store, opts.run.runId]);

  // Follow the selected task/attempt's events.jsonl; switching tasks re-binds the follower.
  useEffect(() => {
    const st = runRef.current.tasks[taskId];
    const chosen = attempt ?? (st?.currentAttempt !== undefined ? st.currentAttempt : st?.attempts[st.attempts.length - 1]?.number);
    setEntries([]);
    if (!st || !chosen) return;
    const file = path.join(opts.store.paths.attemptDir(opts.run.runId, taskId, chosen), 'events.jsonl');
    const controller = new AbortController();
    const buffered: TranscriptEntry[] = [];
    let scheduled = false;
    const flush = (): void => {
      scheduled = false;
      if (!buffered.length) return;
      const batch = buffered.splice(0, buffered.length);
      setEntries((prev) => [...prev, ...batch].slice(-5000));
    };
    void followFile(
      file,
      (line) => {
        const e = parseTranscriptLine(line);
        if (!e) return;
        buffered.push(e);
        if (!scheduled) {
          scheduled = true;
          setTimeout(flush, 30);
        }
      },
      { initialLines: opts.lines, signal: controller.signal },
    );
    return () => controller.abort();
  }, [taskId, attempt, opts.store, opts.run.runId, opts.lines]);

  return (
    <TranscriptViewer
      tasks={tasks}
      taskId={taskId}
      attempt={attempt}
      entries={entries}
      width={stdout?.columns ?? 100}
      height={stdout?.rows ?? 30}
      color={opts.color}
      thinking={opts.thinking}
      loadOlder={(oldest) => {
        const st = runRef.current.tasks[taskId];
        const chosen = attempt ?? (st?.currentAttempt !== undefined ? st.currentAttempt : st?.attempts[st.attempts.length - 1]?.number);
        if (!chosen) return Promise.resolve([]);
        return readOlderEntries(path.join(opts.store.paths.attemptDir(opts.run.runId, taskId, chosen), 'events.jsonl'), oldest);
      }}
      onSelectTask={(id) => {
        setTaskId(id);
        setAttempt(undefined);
      }}
      onSelectAttempt={setAttempt}
      onExit={() => exit()}
      footerHint="Q quit"
    />
  );
}

export async function followLogsInTui(opts: LogsViewerOptions): Promise<void> {
  const instance = render(<LogsApp {...opts} />, { exitOnCtrlC: true, patchConsole: false });
  await instance.waitUntilExit();
}
