/**
 * Self-test for the in-house render harness (`test/helpers/ink-harness.ts`).
 *
 * The harness exists because `ink-testing-library` has no `rows`: it cannot answer "does this screen fit
 * the terminal", which is the rule every full-screen view in `src/tui/` has to keep. So the thing under
 * test here is the harness itself — the size it reports, the keys it delivers, and the resize it emits.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { renderTree, frameHeight, KEYS } from '../helpers/ink-harness.js';

/** A screen that claims the whole terminal: a bordered box of exactly `rows` lines and `columns` cells. */
function FullScreen(props: { label?: string }): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  const body = Math.max(0, rows - 3);
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box borderStyle="round" flexDirection="column" width={columns} height={rows}>
        <Text>
          {props.label ?? 'screen'} {columns}x{rows}
        </Text>
        {Array.from({ length: body }, (_, i) => (
          <Text key={i}>{`row ${i + 1} ${'-'.repeat(Math.max(0, columns - 12))}`}</Text>
        ))}
      </Box>
    </Box>
  );
}

function Keys(props: { pressed: string[] }): React.JSX.Element {
  const [last, setLast] = React.useState('none');
  useInput((input, key) => {
    const name = key.upArrow ? 'up' : key.downArrow ? 'down' : key.tab && key.shift ? 'shift+tab' : key.tab ? 'tab' : key.ctrl && input === 'p' ? 'ctrl+p' : key.return ? 'enter' : input;
    props.pressed.push(name);
    setLast(name);
  });
  return <Text>last: {last}</Text>;
}

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
];

describe('ink harness', () => {
  for (const size of SIZES) {
    it(`renders a full-screen box at ${size.columns}x${size.rows} without exceeding rows`, async () => {
      const tree = renderTree(<FullScreen />, size);
      try {
        const text = await tree.waitFor((frame) => frame.includes(`${size.columns}x${size.rows}`));
        expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(size.rows);
        for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(size.columns);
      } finally {
        tree.unmount();
      }
    });
  }

  it('reports the new size to the tree when the terminal is resized', async () => {
    const tree = renderTree(<FullScreen />, { columns: 80, rows: 24 });
    try {
      await tree.waitFor((frame) => frame.includes('80x24'));
      await tree.resize(120, 40);
      await tree.waitFor((frame) => frame.includes('120x40'));
      expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(40);
      // Shrinking as well: a narrower terminal must not leave the previous width behind.
      await tree.resize(60, 10);
      await tree.waitFor((frame) => frame.includes('60x10'));
      expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(10);
      for (const line of tree.lastText().split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    } finally {
      tree.unmount();
    }
  });

  it('delivers arrows, Shift+Tab and Ctrl+P as the keys a terminal sends', async () => {
    const pressed: string[] = [];
    const tree = renderTree(<Keys pressed={pressed} />, { columns: 40, rows: 6 });
    try {
      await tree.waitFor((frame) => frame.includes('last: none'));
      for (const keys of [KEYS.up, KEYS.down, KEYS.shiftTab, KEYS.ctrlP, KEYS.enter, 'x']) tree.write(keys);
      await tree.waitFor((frame) => frame.includes('last: x'));
      expect(pressed).toEqual(['up', 'down', 'shift+tab', 'ctrl+p', 'enter', 'x']);
    } finally {
      tree.unmount();
    }
  });

  it('keeps every frame it rendered, and gives up on waitFor rather than hanging', async () => {
    const tree = renderTree(<FullScreen label="first" />, { columns: 40, rows: 6 });
    try {
      await tree.waitFor((frame) => frame.includes('first'));
      tree.rerender(<FullScreen label="second" />);
      await tree.waitFor((frame) => frame.includes('second'));
      expect(tree.frames.length).toBeGreaterThan(1);
      await expect(tree.waitFor((frame) => frame.includes('never'), { timeout: 60 })).rejects.toThrow(/waitFor timed out/);
    } finally {
      tree.unmount();
    }
  });
});
