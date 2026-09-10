/**
 * `~/.cao/presence/<pid>.json` — one file per running surface. Spec §4.6.1.
 *
 * Emit is a persisted, machine-wide preference; presence is a fact about right now. Conflating them is what
 * would make `cao emit enable` change the behaviour of every headless run on the machine (§4.6), so
 * `canInteract` is `the Ink TUI is attached || emit is on && some fresh presence exists on this machine`.
 *
 * Keyed by pid so several surfaces can coexist and a crashed one can expire. Live while `heartbeatAt` is
 * inside 60 s — the same staleness window as `lock.json`, `live.json` and a stale registry entry, so there is
 * one number to reason about rather than four. Deleted on clean exit; a file whose `machine` does not match
 * is ignored entirely.
 */
import type { CapabilityToken, MachineIdentity, ProtocolVersion } from './protocol.js';

export interface PresenceFile {
  protocol: ProtocolVersion;
  pid: number;
  machine: MachineIdentity;
  /** Free text naming the surface: e.g. `cao-desktop 0.1.0`. */
  surface: string;
  startedAt: string;
  /** 20 s tick, matching `lock.json`. */
  heartbeatAt: string;
  /**
   * The mirror of a registry entry's `capabilities` (§4.2.3): the entry says what a run can do, presence says
   * what this surface knows how to ask for, and each side gates on the other's list. Neither ever checks a
   * version number to decide what a button does.
   */
  understands: CapabilityToken[];
}
