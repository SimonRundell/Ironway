import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Determinism guard: DESIGN.md 4.5 requires every random draw under
 * src/sim to come from a seeded stream (rngFor), never the native
 * non-deterministic generator. This walks the whole folder and fails
 * if a call to it ever creeps back into source.
 *
 * The forbidden text is built with string concatenation rather than
 * written literally, so this file (which necessarily discusses it)
 * does not trip its own check.
 *
 * @module sim/noRandom.test
 */

const FORBIDDEN_CALL = 'Math.' + 'random('

/**
 * Recursively lists .js/.jsx files under a directory.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute-ish paths to every .js/.jsx file found.
 */
function listJsFiles(dir) {
  let files = []

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files = files.concat(listJsFiles(full))
    } else if (entry.endsWith('.js') || entry.endsWith('.jsx')) {
      files.push(full)
    }
  }

  return files
}

describe('determinism guard', () => {
  it('never calls the native non-deterministic generator under src/sim', () => {
    const offenders = listJsFiles('src/sim').filter((file) =>
      readFileSync(file, 'utf8').includes(FORBIDDEN_CALL),
    )

    expect(offenders).toEqual([])
  })
})
