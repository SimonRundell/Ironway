import { describe, expect, it } from 'vitest'
import { decayStock } from './decay.js'

const CARGO_CATALOGUE = [
  { id: 'food', decayPerMonth: 0.08 },
  { id: 'coal', decayPerMonth: 0 },
  { id: 'milk', decayPerMonth: 0.30 },
]

describe('decayStock', () => {
  it('shrinks each cargo by its own decayPerMonth rate', () => {
    const next = decayStock({ food: 100, coal: 50, milk: 20 }, CARGO_CATALOGUE)
    expect(next.food).toBeCloseTo(92)
    expect(next.coal).toBe(50)
    expect(next.milk).toBeCloseTo(14)
  })

  it('treats a cargo missing from the catalogue as non-decaying', () => {
    const next = decayStock({ mystery: 10 }, CARGO_CATALOGUE)
    expect(next.mystery).toBe(10)
  })

  it('does not mutate the input stock object', () => {
    const stock = { food: 100 }
    decayStock(stock, CARGO_CATALOGUE)
    expect(stock.food).toBe(100)
  })

  it('returns an empty object for empty stock', () => {
    expect(decayStock({}, CARGO_CATALOGUE)).toEqual({})
  })
})
