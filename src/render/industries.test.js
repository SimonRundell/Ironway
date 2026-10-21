import { describe, expect, it } from 'vitest'
import {
  categoryHasSmoke,
  furnaceGlowIntensity,
  industryColour,
  isIdle,
  lifecyclePhase,
  particleCountFor,
  particleState,
  spriteCategoryFor,
  wheelAngle,
} from './industries.js'

const INDUSTRIES_RULES = {
  spriteCategoryByTypeId: { coal_mine: 'mine', flour_mill: 'watermill', ironworks: 'furnace', shipyard: 'shipyard' },
  colourByTypeId: { coal_mine: '#3a3a3a', flour_mill: '#c9b15a' },
  smokeByCategory: { mine: true, watermill: false, furnace: true, shipyard: true, factory: true },
  idleUtilisation: 0.05,
  constructionDays: 180,
  derelictFullDays: 720,
  maxParticlesPerIndustry: 4,
  particleLifeMs: 3000,
  particleRiseMiles: 0.9,
}

function makeIndustry(overrides = {}) {
  return {
    id: 5,
    typeId: 'coal_mine',
    name: 'Test Mine',
    x: 10,
    y: 20,
    homeSettlementId: 1,
    capacity: 3000,
    utilisation: 0.8,
    richnessLeft: 1,
    openedDay: 0,
    closedDay: null,
    monthsLow: 0,
    stock: {},
    ...overrides,
  }
}

describe('spriteCategoryFor', () => {
  it('looks up the configured category', () => {
    expect(spriteCategoryFor('coal_mine', INDUSTRIES_RULES)).toBe('mine')
    expect(spriteCategoryFor('flour_mill', INDUSTRIES_RULES)).toBe('watermill')
  })

  it('falls back to factory for an unmapped type', () => {
    expect(spriteCategoryFor('mystery_works', INDUSTRIES_RULES)).toBe('factory')
  })
})

describe('industryColour', () => {
  it('converts the configured hex colour', () => {
    expect(industryColour('coal_mine', INDUSTRIES_RULES)).toEqual({ r: 58, g: 58, b: 58 })
  })

  it('falls back to a grey for an unmapped type', () => {
    const colour = industryColour('mystery_works', INDUSTRIES_RULES)
    expect(Number.isNaN(colour.r)).toBe(false)
  })
})

describe('categoryHasSmoke', () => {
  it('reads true/false per category', () => {
    expect(categoryHasSmoke('mine', INDUSTRIES_RULES)).toBe(true)
    expect(categoryHasSmoke('watermill', INDUSTRIES_RULES)).toBe(false)
  })
})

describe('lifecyclePhase', () => {
  it('is construction for the first constructionDays after opening', () => {
    const industry = makeIndustry({ openedDay: 100 })
    const result = lifecyclePhase(industry, 150, INDUSTRIES_RULES)
    expect(result.phase).toBe('construction')
    expect(result.constructionT).toBeCloseTo(50 / 180)
  })

  it('is operating once past constructionDays', () => {
    const industry = makeIndustry({ openedDay: 100 })
    expect(lifecyclePhase(industry, 100 + 180, INDUSTRIES_RULES).phase).toBe('operating')
  })

  it('is derelict once closed, regardless of how recently it opened', () => {
    const industry = makeIndustry({ openedDay: 100, closedDay: 110 })
    const result = lifecyclePhase(industry, 110 + 360, INDUSTRIES_RULES)
    expect(result.phase).toBe('derelict')
    expect(result.derelictT).toBeCloseTo(0.5)
  })

  it('caps derelictT at 1', () => {
    const industry = makeIndustry({ closedDay: 0 })
    expect(lifecyclePhase(industry, 10000, INDUSTRIES_RULES).derelictT).toBe(1)
  })
})

describe('isIdle', () => {
  it('is true below idleUtilisation', () => {
    expect(isIdle(makeIndustry({ utilisation: 0.01 }), INDUSTRIES_RULES)).toBe(true)
  })

  it('is false at or above idleUtilisation', () => {
    expect(isIdle(makeIndustry({ utilisation: 0.5 }), INDUSTRIES_RULES)).toBe(false)
  })
})

describe('particleCountFor', () => {
  it('is zero when not operating', () => {
    const industry = makeIndustry()
    expect(particleCountFor(industry, 'mine', { phase: 'construction' }, INDUSTRIES_RULES)).toBe(0)
    expect(particleCountFor(industry, 'mine', { phase: 'derelict' }, INDUSTRIES_RULES)).toBe(0)
  })

  it('is zero for a non-smoke category even while operating', () => {
    const industry = makeIndustry({ utilisation: 0.9 })
    expect(particleCountFor(industry, 'watermill', { phase: 'operating' }, INDUSTRIES_RULES)).toBe(0)
  })

  it('is zero while idle (Done-when: idle industries do not animate)', () => {
    const industry = makeIndustry({ utilisation: 0.01 })
    expect(particleCountFor(industry, 'mine', { phase: 'operating' }, INDUSTRIES_RULES)).toBe(0)
  })

  it('scales with utilisation up to maxParticlesPerIndustry', () => {
    const low = particleCountFor(makeIndustry({ utilisation: 0.1 }), 'mine', { phase: 'operating' }, INDUSTRIES_RULES)
    const high = particleCountFor(makeIndustry({ utilisation: 1 }), 'mine', { phase: 'operating' }, INDUSTRIES_RULES)
    expect(low).toBeGreaterThanOrEqual(1)
    expect(high).toBe(4)
    expect(high).toBeGreaterThan(low)
  })
})

describe('particleState', () => {
  it('is deterministic for the same inputs', () => {
    const a = particleState(5, 0, 1000, INDUSTRIES_RULES)
    const b = particleState(5, 0, 1000, INDUSTRIES_RULES)
    expect(a).toEqual(b)
  })

  it('rises from 0 toward particleRiseMiles over one cycle', () => {
    const early = particleState(5, 0, 0, INDUSTRIES_RULES)
    expect(early.riseMiles).toBeGreaterThanOrEqual(0)
    expect(early.riseMiles).toBeLessThan(INDUSTRIES_RULES.particleRiseMiles)
  })

  it('alpha follows a sin(t*pi) rise-and-fade shape derived from its own rise fraction', () => {
    const state = particleState(5, 0, 1234, INDUSTRIES_RULES)
    const t = state.riseMiles / INDUSTRIES_RULES.particleRiseMiles
    expect(state.alpha).toBeCloseTo(Math.sin(t * Math.PI))
    expect(state.alpha).toBeGreaterThanOrEqual(0)
    expect(state.alpha).toBeLessThanOrEqual(1)
  })

  it('different slots get different phase offsets', () => {
    const a = particleState(5, 0, 1000, INDUSTRIES_RULES)
    const b = particleState(5, 1, 1000, INDUSTRIES_RULES)
    expect(a).not.toEqual(b)
  })
})

describe('wheelAngle', () => {
  it('is zero when not operating', () => {
    expect(wheelAngle(makeIndustry(), { phase: 'construction' }, 5000, INDUSTRIES_RULES)).toBe(0)
  })

  it('is zero while idle', () => {
    expect(wheelAngle(makeIndustry({ utilisation: 0.01 }), { phase: 'operating' }, 5000, INDUSTRIES_RULES)).toBe(0)
  })

  it('advances with time when operating and not idle', () => {
    const industry = makeIndustry({ utilisation: 0.8 })
    const a = wheelAngle(industry, { phase: 'operating' }, 1000, INDUSTRIES_RULES)
    const b = wheelAngle(industry, { phase: 'operating' }, 2000, INDUSTRIES_RULES)
    expect(b).not.toBe(a)
  })

  it('turns faster at higher utilisation', () => {
    const slow = wheelAngle(makeIndustry({ utilisation: 0.2 }), { phase: 'operating' }, 1000, INDUSTRIES_RULES)
    const fast = wheelAngle(makeIndustry({ utilisation: 1 }), { phase: 'operating' }, 1000, INDUSTRIES_RULES)
    expect(fast).toBeGreaterThan(slow)
  })
})

describe('furnaceGlowIntensity', () => {
  it('is zero when not operating', () => {
    expect(furnaceGlowIntensity(makeIndustry(), { phase: 'derelict' }, 1000, INDUSTRIES_RULES)).toBe(0)
  })

  it('is zero while idle', () => {
    expect(furnaceGlowIntensity(makeIndustry({ utilisation: 0.01 }), { phase: 'operating' }, 1000, INDUSTRIES_RULES)).toBe(0)
  })

  it('is positive and bounded when operating and not idle', () => {
    const glow = furnaceGlowIntensity(makeIndustry({ utilisation: 0.8 }), { phase: 'operating' }, 1000, INDUSTRIES_RULES)
    expect(glow).toBeGreaterThan(0)
    expect(glow).toBeLessThanOrEqual(1)
  })
})
