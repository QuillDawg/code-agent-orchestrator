/**
 * ULIDs for control commands and the request files that carry them (spec §2.2, §2.3, `[D38]`).
 *
 * A ULID rather than a UUID because the id is also the request file's name prefix, and Crockford base32 of
 * the timestamp sorts lexicographically by time: a plain `readdir` of `requests/` is request order, with no
 * index and no parsing. 48 bits of time to the millisecond, 80 bits of randomness.
 *
 * In-house rather than a dependency: this is thirty lines, the format is frozen, and the alternative is a
 * runtime dependency in the hot path of every keystroke that reaches the run controller.
 */
import { randomFillSync } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so a ULID read off a screen cannot be mistyped into a different one. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** Last millisecond handed out, and the randomness used for it, so ids minted in one tick still sort. */
let lastTime = -1;
const lastRandom = new Uint8Array(RANDOM_CHARS);

function encodeTime(ms: number): string {
  let out = '';
  let value = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** Increment the randomness in place, so several ids in the same millisecond keep their order. */
function bumpRandom(): void {
  for (let i = RANDOM_CHARS - 1; i >= 0; i--) {
    if (lastRandom[i]! < 31) {
      lastRandom[i]! += 1;
      return;
    }
    lastRandom[i] = 0;
  }
}

/**
 * A new ULID. Monotonic: two ids minted in the same millisecond sort in the order they were minted, which
 * is what lets the inbox apply two commands sent in one keystroke in the order the operator meant them.
 */
export function ulid(now: number = Date.now()): string {
  const ms = Math.max(0, Math.floor(now));
  if (ms === lastTime) {
    bumpRandom();
  } else {
    lastTime = ms;
    randomFillSync(lastRandom);
    for (let i = 0; i < RANDOM_CHARS; i++) lastRandom[i] = lastRandom[i]! % 32;
  }
  let random = '';
  for (let i = 0; i < RANDOM_CHARS; i++) random += ALPHABET[lastRandom[i]!];
  return encodeTime(ms) + random;
}
