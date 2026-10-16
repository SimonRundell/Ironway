import { describe, expect, it } from 'vitest'
import { domainWarp2D, fbm2D, ridgedNoise2D, valueNoise2D } from './noise.js'

describe('valueNoise2D', () => {
  it('matches a fixed golden value for a fixed seed and coordinate', () => {
    expect(valueNoise2D(12345, 3.25, 7.75)).toBe(0.9109425831069569)
  })

  it('is deterministic across independent calls', () => {
    expect(valueNoise2D(555, 1.1, 2.2)).toBe(valueNoise2D(555, 1.1, 2.2))
  })

  it('stays within [0, 1) and is reasonably well distributed', () => {
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let count = 0

    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        const value = valueNoise2D(999, x * 0.37, y * 0.53)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThan(1)
        sum += value
        min = Math.min(min, value)
        max = Math.max(max, value)
        count++
      }
    }

    const mean = sum / count
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    expect(min).toBeLessThan(0.1)
    expect(max).toBeGreaterThan(0.9)
  })

  it('is smooth: adjacent samples differ only a little', () => {
    const a = valueNoise2D(42, 5.0, 5.0)
    const b = valueNoise2D(42, 5.01, 5.0)
    expect(Math.abs(a - b)).toBeLessThan(0.05)
  })
})

describe('fbm2D', () => {
  it('matches a fixed golden value', () => {
    expect(fbm2D(12345, 10.5, 20.5, 6, 2, 0.5)).toBe(0.35719115864707246)
  })

  it('is deterministic across independent calls', () => {
    expect(fbm2D(1, 1, 1)).toBe(fbm2D(1, 1, 1))
  })

  it('stays within [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const value = fbm2D(7, i * 0.9, i * 1.3)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('ridgedNoise2D', () => {
  it('matches a fixed golden value', () => {
    expect(ridgedNoise2D(12345, 10.5, 20.5, 6, 2, 0.5)).toBe(0.23696194226793613)
  })

  it('stays within [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const value = ridgedNoise2D(7, i * 0.9, i * 1.3)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('domainWarp2D', () => {
  it('matches a fixed golden value', () => {
    const [x, y] = domainWarp2D(12345, 10.5, 20.5, 2.0, 2)
    expect(x).toBe(11.24740110632653)
    expect(y).toBe(19.893057691399008)
  })

  it('keeps the displacement bounded by the given strength', () => {
    const strength = 3
    const [x, y] = domainWarp2D(1, 50, 50, strength, 2)
    expect(Math.abs(x - 50)).toBeLessThanOrEqual(strength)
    expect(Math.abs(y - 50)).toBeLessThanOrEqual(strength)
  })
})
