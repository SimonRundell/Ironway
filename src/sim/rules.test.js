import { describe, expect, it } from 'vitest'
import { loadRulesNode, readRulesRawNode, RulesError, validateRules } from './rules.js'

const DATA_DIR = 'public/data'

describe('rules loader', () => {
  it('loads the real public/data files and freezes the result', async () => {
    const rules = await loadRulesNode(DATA_DIR)

    expect(rules.cargo.length).toBeGreaterThan(0)
    expect(rules.industries.length).toBeGreaterThan(0)
    expect(Object.isFrozen(rules)).toBe(true)
    expect(Object.isFrozen(rules.cargo)).toBe(true)
    expect(Object.isFrozen(rules.cargo[0])).toBe(true)
  })

  it('rejects a missing field', async () => {
    const raw = await readRulesRawNode(DATA_DIR)
    delete raw.cargo.cargo[0].basePrice

    let error
    try {
      validateRules(raw)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(RulesError)
    expect(error.file).toBe('cargo')
    expect(error.key).toContain('basePrice')
  })

  it('rejects an unknown cargo id referenced by an industry', async () => {
    const raw = await readRulesRawNode(DATA_DIR)
    raw.industries.industries[0].outputs = { not_a_real_cargo: 100 }

    let error
    try {
      validateRules(raw)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(RulesError)
    expect(error.file).toBe('industries')
    expect(error.message).toContain('not_a_real_cargo')
  })

  it('rejects a negative price', async () => {
    const raw = await readRulesRawNode(DATA_DIR)
    raw.cargo.cargo[0].basePrice = -5

    let error
    try {
      validateRules(raw)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(RulesError)
    expect(error.file).toBe('cargo')
    expect(error.key).toContain('basePrice')
  })

  it('rejects an era table that is out of order', async () => {
    const raw = await readRulesRawNode(DATA_DIR)
    const table = raw.eras.deathRatePer1000PerYear
    ;[table[0], table[1]] = [table[1], table[0]]

    let error
    try {
      validateRules(raw)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(RulesError)
    expect(error.file).toBe('eras')
    expect(error.message).toContain('ascending')
  })

  it('names the file and key in a readable message for a broken fixture', async () => {
    const raw = await readRulesRawNode(DATA_DIR)
    delete raw.classes.classes[0].mobility

    let error
    try {
      validateRules(raw)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(RulesError)
    expect(error.message).toContain('classes.json')
    expect(error.message).toContain('mobility')
  })
})
