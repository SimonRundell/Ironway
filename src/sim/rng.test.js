import { describe, expect, it } from 'vitest'
import { gaussian, hashString, int, pick, rngFor, shuffle } from './rng.js'

describe('hashString', () => {
  it('is deterministic', () => {
    expect(hashString('ironway-001')).toBe(hashString('ironway-001'))
  })

  it('gives different strings different hashes', () => {
    expect(hashString('ironway-001')).not.toBe(hashString('ironway-002'))
  })
})

describe('rngFor', () => {
  it('produces a fixed golden sequence for a fixed seed and keys', () => {
    const rng = rngFor('golden-seed', 'test')
    const values = Array.from({ length: 10 }, () => rng())

    expect(values).toEqual([
      0.07666597166098654, 0.25338796246796846, 0.595893784891814,
      0.644528042525053, 0.27311655203811824, 0.29653975018300116,
      0.5986104500479996, 0.7870282160583884, 0.0844231597147882,
      0.10917209042236209,
    ])
  })

  it('gives identical results across independent streams with the same seed and keys', () => {
    const a = Array.from({ length: 20 }, rngFor('cross-run', 'a'))
    const b = Array.from({ length: 20 }, rngFor('cross-run', 'a'))
    expect(a).toEqual(b)
  })

  it('gives different streams for different keys on the same seed', () => {
    const a = rngFor('same-seed', 'a')()
    const b = rngFor('same-seed', 'b')()
    expect(a).not.toBe(b)
  })

  it('every draw is in [0, 1)', () => {
    const rng = rngFor('range-check')
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('int', () => {
  it('stays within [min, max] inclusive', () => {
    const rng = rngFor('int-range')
    for (let i = 0; i < 500; i++) {
      const v = int(rng, 5, 9)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThanOrEqual(9)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('is deterministic for a fixed seed', () => {
    const a = Array.from({ length: 10 }, () => int(rngFor('int-golden'), 1, 6))
    const b = Array.from({ length: 10 }, () => int(rngFor('int-golden'), 1, 6))
    expect(a).toEqual(b)
  })
})

describe('pick', () => {
  it('always returns an element of the array', () => {
    const rng = rngFor('pick-check')
    const options = ['a', 'b', 'c', 'd']
    for (let i = 0; i < 100; i++) {
      expect(options).toContain(pick(rng, options))
    }
  })
})

describe('shuffle', () => {
  it('returns a permutation of the input without mutating it', () => {
    const input = [1, 2, 3, 4, 5]
    const result = shuffle(rngFor('shuffle-check'), input)

    expect(input).toEqual([1, 2, 3, 4, 5])
    expect(result).toHaveLength(input.length)
    expect([...result].sort()).toEqual(input)
  })

  it('is deterministic for a fixed seed', () => {
    const a = shuffle(rngFor('shuffle-golden'), [1, 2, 3, 4, 5])
    const b = shuffle(rngFor('shuffle-golden'), [1, 2, 3, 4, 5])
    expect(a).toEqual(b)
  })
})

describe('gaussian', () => {
  it('approximates a standard normal distribution over many draws', () => {
    const rng = rngFor('gaussian-distribution')
    const samples = Array.from({ length: 5000 }, () => gaussian(rng))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length

    expect(mean).toBeGreaterThan(-0.1)
    expect(mean).toBeLessThan(0.1)
    expect(variance).toBeGreaterThan(0.8)
    expect(variance).toBeLessThan(1.2)
  })

  it('is deterministic for a fixed seed', () => {
    const a = gaussian(rngFor('gaussian-golden'))
    const b = gaussian(rngFor('gaussian-golden'))
    expect(a).toBe(b)
  })
})
