/**
 * Loads and validates the static rules JSON files from public/data/ (see
 * DESIGN.md 8.1), freezing the result so simulation code cannot
 * accidentally mutate shared data. Works in the browser (fetch) and in
 * Node (fs), for use from React, Vitest and scripts/balance.mjs alike.
 *
 * @module sim/rules
 */

/** @type {readonly string[]} The data files every rules set must have. */
const REQUIRED_FILES = Object.freeze([
  'client', 'mapgen', 'terrain', 'settlements', 'names', 'classes',
  'cargo', 'industries', 'economy', 'difficulty', 'eras', 'links',
  'vehicles', 'ranks', 'palette',
])

const CARGO_CATEGORIES = new Set(['bulk', 'general', 'perishable', 'livestock', 'liquid', 'special'])
const INDUSTRY_TIERS = new Set(['primary', 'secondary', 'tertiary'])
const VEHICLE_MODES = new Set(['road', 'rail', 'sea'])
const VEHICLE_KINDS = new Set(['loco', 'wagon', 'coach', 'truck', 'bus'])

/**
 * Thrown when a rules file fails validation. The message, and the
 * separate `file`/`key` fields, always name the offending file and the
 * path within it so a broken fixture is easy to track down.
 */
export class RulesError extends Error {
  /**
   * @param {string} file    Rules file name, without extension.
   * @param {string} key     Path within the file, e.g. "industries[3].inputs[0]".
   * @param {string} message What is wrong.
   */
  constructor(file, key, message) {
    super(`${file}.json: ${key}: ${message}`)
    this.name = 'RulesError'
    this.file = file
    this.key = key
  }
}

/**
 * Throws a RulesError. Centralised so every check reports consistently.
 *
 * @param {string} file    Rules file name, without extension.
 * @param {string} key     Path within the file.
 * @param {string} message What is wrong.
 * @returns {never}
 */
function fail(file, key, message) {
  throw new RulesError(file, key, message)
}

/**
 * Requires a field to be present (not undefined or null) on an object.
 *
 * @param {object} obj     The object to check.
 * @param {string} field   The field name.
 * @param {string} file    Rules file name, for error reporting.
 * @param {string} context Path to `obj`, for error reporting.
 * @returns {*} The field's value.
 */
function requireField(obj, field, file, context) {
  if (obj === null || obj === undefined || obj[field] === undefined || obj[field] === null) {
    fail(file, `${context}.${field}`, 'is required.')
  }
  return obj[field]
}

/**
 * Fails unless `cargoId` is a known cargo id.
 *
 * @param {string} file     Rules file name of the referencing entry.
 * @param {string} context  Path to the reference, for error reporting.
 * @param {string} cargoId  The cargo id to check.
 * @param {Set<string>} cargoIds All known cargo ids.
 * @returns {void}
 */
function checkCargoRef(file, context, cargoId, cargoIds) {
  if (!cargoIds.has(cargoId)) {
    fail(file, context, `references unknown cargo "${cargoId}".`)
  }
}

/**
 * Fails unless every row in a year-indexed table is in strictly
 * ascending order by `year`.
 *
 * @param {string} file  Rules file name.
 * @param {string} key   Table name, for error reporting.
 * @param {Array<{year: number}>} table The table to check.
 * @returns {void}
 */
function checkAscendingYears(file, key, table) {
  if (!Array.isArray(table) || table.length === 0) {
    fail(file, key, 'must be a non-empty array.')
  }

  table.forEach((row, index) => requireField(row, 'year', file, `${key}[${index}]`))

  for (let i = 1; i < table.length; i++) {
    if (table[i].year <= table[i - 1].year) {
      fail(file, `${key}[${i}].year`, 'must be greater than the previous entry (table must be sorted ascending by year).')
    }
  }
}

/**
 * Validates cargo.json.
 *
 * @param {{cargo: object[]}} data Parsed cargo.json.
 * @returns {object[]} The cargo array.
 */
function validateCargo(data) {
  const file = 'cargo'

  if (!data || !Array.isArray(data.cargo)) {
    fail(file, 'cargo', 'must be an array.')
  }

  const seenIds = new Set()

  data.cargo.forEach((entry, index) => {
    const context = `cargo[${index}]`

    for (const field of ['id', 'name', 'unit', 'category', 'basePrice', 'elasticity', 'decayPerMonth', 'eraFrom', 'importable', 'exportable']) {
      requireField(entry, field, file, context)
    }

    if (seenIds.has(entry.id)) {
      fail(file, `${context}.id`, `duplicate cargo id "${entry.id}".`)
    }
    seenIds.add(entry.id)

    if (!CARGO_CATEGORIES.has(entry.category)) {
      fail(file, `${context}.category`, `unknown category "${entry.category}".`)
    }
    if (typeof entry.basePrice !== 'number' || entry.basePrice < 0) {
      fail(file, `${context}.basePrice`, 'must be a non-negative number.')
    }
    if (typeof entry.elasticity !== 'number' || entry.elasticity < 0) {
      fail(file, `${context}.elasticity`, 'must be a non-negative number.')
    }
    if (typeof entry.decayPerMonth !== 'number' || entry.decayPerMonth < 0) {
      fail(file, `${context}.decayPerMonth`, 'must be a non-negative number.')
    }
  })

  return data.cargo
}

/**
 * Validates industries.json, including that every cargo id referenced
 * in inputs or outputs exists in cargo.json.
 *
 * @param {{industries: object[]}} data Parsed industries.json.
 * @param {Set<string>} cargoIds Known cargo ids from cargo.json.
 * @returns {object[]} The industries array.
 */
function validateIndustries(data, cargoIds) {
  const file = 'industries'

  if (!data || !Array.isArray(data.industries)) {
    fail(file, 'industries', 'must be an array.')
  }

  const seenIds = new Set()

  data.industries.forEach((entry, index) => {
    const context = `industries[${index}]`

    for (const field of ['id', 'name', 'tier', 'siteRules', 'inputs', 'outputs', 'jobs', 'eraFrom', 'maxPerNode', 'storageMonths']) {
      requireField(entry, field, file, context)
    }

    if (seenIds.has(entry.id)) {
      fail(file, `${context}.id`, `duplicate industry id "${entry.id}".`)
    }
    seenIds.add(entry.id)

    if (!INDUSTRY_TIERS.has(entry.tier)) {
      fail(file, `${context}.tier`, `unknown tier "${entry.tier}".`)
    }

    if (!Array.isArray(entry.siteRules)) {
      fail(file, `${context}.siteRules`, 'must be an array.')
    }
    entry.siteRules.forEach((rule, ruleIndex) => {
      const isPlainRule = typeof rule === 'string'
      const isAnyRule = rule !== null && typeof rule === 'object' && Array.isArray(rule.any)
      if (!isPlainRule && !isAnyRule) {
        fail(file, `${context}.siteRules[${ruleIndex}]`, 'must be a string or { "any": [...] }.')
      }
    })

    if (!Array.isArray(entry.inputs)) {
      fail(file, `${context}.inputs`, 'must be an array.')
    }
    entry.inputs.forEach((requirement, reqIndex) => {
      const reqContext = `${context}.inputs[${reqIndex}]`
      if (requirement && requirement.any) {
        for (const cargoId of Object.keys(requirement.any)) {
          checkCargoRef(file, reqContext, cargoId, cargoIds)
        }
      } else if (requirement && requirement.cargo) {
        checkCargoRef(file, reqContext, requirement.cargo, cargoIds)
      } else {
        fail(file, reqContext, 'must have "cargo" or "any".')
      }
    })

    if (typeof entry.outputs !== 'object' || entry.outputs === null) {
      fail(file, `${context}.outputs`, 'must be an object.')
    }
    for (const [cargoId, qty] of Object.entries(entry.outputs)) {
      checkCargoRef(file, `${context}.outputs`, cargoId, cargoIds)
      if (typeof qty !== 'number' || qty <= 0) {
        fail(file, `${context}.outputs.${cargoId}`, 'must be a positive number.')
      }
    }

    for (const jobField of ['working', 'middle', 'upper']) {
      requireField(entry.jobs, jobField, file, `${context}.jobs`)
    }
  })

  return data.industries
}

/**
 * Validates eras.json: its four year-indexed tables must each be
 * sorted ascending by year.
 *
 * @param {object} data Parsed eras.json.
 * @returns {object} The same object, validated.
 */
function validateEras(data) {
  const file = 'eras'

  for (const field of ['timeline', 'agriProductivityMultiplier', 'birthRatePer1000PerYear', 'deathRatePer1000PerYear', 'worldTrade']) {
    requireField(data, field, file, '(root)')
  }

  checkAscendingYears(file, 'timeline', data.timeline)
  checkAscendingYears(file, 'agriProductivityMultiplier', data.agriProductivityMultiplier)
  checkAscendingYears(file, 'birthRatePer1000PerYear', data.birthRatePer1000PerYear)
  checkAscendingYears(file, 'deathRatePer1000PerYear', data.deathRatePer1000PerYear)

  return data
}

/**
 * Validates links.json.
 *
 * @param {object} data Parsed links.json.
 * @returns {object} The same object, validated.
 */
function validateLinks(data) {
  const file = 'links'

  for (const field of ['road', 'rail', 'sea']) {
    requireField(data, field, file, '(root)')
  }

  for (const mode of ['road', 'rail']) {
    if (!Array.isArray(data[mode])) {
      fail(file, mode, 'must be an array.')
    }
    data[mode].forEach((tier, index) => {
      for (const field of ['tier', 'name', 'speedMph', 'freightTonnesPerMonth', 'passengersPerMonth', 'eraFrom']) {
        requireField(tier, field, file, `${mode}[${index}]`)
      }
    })
  }

  if (!Array.isArray(data.sea.byPortTier)) {
    fail(file, 'sea.byPortTier', 'must be an array.')
  }

  return data
}

/**
 * Validates vehicles.json.
 *
 * @param {{vehicles: object[]}} data Parsed vehicles.json.
 * @returns {object[]} The vehicles array.
 */
function validateVehicles(data) {
  const file = 'vehicles'

  if (!data || !Array.isArray(data.vehicles)) {
    fail(file, 'vehicles', 'must be an array.')
  }

  const seenIds = new Set()

  data.vehicles.forEach((vehicle, index) => {
    const context = `vehicles[${index}]`

    for (const field of ['id', 'mode', 'kind', 'name', 'introYear', 'price', 'maintenanceRate']) {
      requireField(vehicle, field, file, context)
    }

    if (seenIds.has(vehicle.id)) {
      fail(file, `${context}.id`, `duplicate vehicle id "${vehicle.id}".`)
    }
    seenIds.add(vehicle.id)

    if (!VEHICLE_MODES.has(vehicle.mode)) {
      fail(file, `${context}.mode`, `unknown mode "${vehicle.mode}".`)
    }
    if (!VEHICLE_KINDS.has(vehicle.kind)) {
      fail(file, `${context}.kind`, `unknown kind "${vehicle.kind}".`)
    }
    if (typeof vehicle.price !== 'number' || vehicle.price < 0) {
      fail(file, `${context}.price`, 'must be a non-negative number.')
    }
  })

  return data.vehicles
}

/**
 * Validates economy.json.
 *
 * @param {object} data Parsed economy.json.
 * @returns {object} The same object, validated.
 */
function validateEconomy(data) {
  const file = 'economy'

  for (const field of [
    'yields', 'seasonal', 'demandPerThousandPerMonth', 'confidenceSpendingFactor',
    'price', 'flow', 'population', 'attractivenessWeights', 'confidence',
    'levels', 'economyLevelScore',
  ]) {
    requireField(data, field, file, '(root)')
  }

  if (!Array.isArray(data.levels) || data.levels.length !== 5) {
    fail(file, 'levels', 'must be an array of 5 economy levels.')
  }

  data.levels.forEach((level, index) => {
    const context = `levels[${index}]`
    for (const field of ['level', 'name', 'production', 'demand', 'revenue', 'buildCost', 'interestRate', 'taxRate']) {
      requireField(level, field, file, context)
    }
    if (level.level !== index) {
      fail(file, `${context}.level`, `expected level ${index}, got ${level.level}.`)
    }
  })

  if (data.price.pMin >= data.price.pMax) {
    fail(file, 'price', 'pMin must be less than pMax.')
  }

  return data
}

/**
 * Validates classes.json.
 *
 * @param {{classes: object[]}} data Parsed classes.json.
 * @returns {object[]} The classes array.
 */
function validateClasses(data) {
  const file = 'classes'

  if (!data || !Array.isArray(data.classes) || data.classes.length === 0) {
    fail(file, 'classes', 'must be a non-empty array.')
  }

  data.classes.forEach((entry, index) => {
    const context = `classes[${index}]`
    for (const field of ['id', 'name', 'participation', 'mobility', 'baseWagePerMonth']) {
      requireField(entry, field, file, context)
    }
    if (entry.participation < 0 || entry.participation > 1) {
      fail(file, `${context}.participation`, 'must be between 0 and 1.')
    }
  })

  return data.classes
}

/**
 * Validates difficulty.json.
 *
 * @param {{difficulties: object[]}} data Parsed difficulty.json.
 * @returns {object[]} The difficulties array.
 */
function validateDifficulty(data) {
  const file = 'difficulty'

  if (!data || !Array.isArray(data.difficulties) || data.difficulties.length === 0) {
    fail(file, 'difficulties', 'must be a non-empty array.')
  }

  data.difficulties.forEach((entry, index) => {
    const context = `difficulties[${index}]`
    for (const field of ['id', 'name', 'startingCash', 'shockAmplitude', 'demandMode', 'startingPopulationScale']) {
      requireField(entry, field, file, context)
    }
    if (entry.demandMode !== 'basic' && entry.demandMode !== 'complex') {
      fail(file, `${context}.demandMode`, `unknown demandMode "${entry.demandMode}".`)
    }
  })

  return data.difficulties
}

/**
 * Validates ranks.json.
 *
 * @param {{ranks: object[], achievements: object[]}} data Parsed ranks.json.
 * @returns {object} The same object, validated.
 */
function validateRanks(data) {
  const file = 'ranks'

  if (!data || !Array.isArray(data.ranks) || !Array.isArray(data.achievements)) {
    fail(file, '(root)', 'must have "ranks" and "achievements" arrays.')
  }

  data.ranks.forEach((rank, index) => {
    for (const field of ['key', 'name', 'minNetWorth']) {
      requireField(rank, field, file, `ranks[${index}]`)
    }
  })

  data.achievements.forEach((achievement, index) => {
    for (const field of ['key', 'name', 'description']) {
      requireField(achievement, field, file, `achievements[${index}]`)
    }
  })

  return data
}

/**
 * Validates terrain.json: every enum entry must have a debug colour.
 *
 * @param {{landuseEnum: string[], debugColours: object}} data Parsed terrain.json.
 * @returns {object} The same object, validated.
 */
function validateTerrain(data) {
  const file = 'terrain'

  requireField(data, 'landuseEnum', file, '(root)')
  requireField(data, 'debugColours', file, '(root)')

  for (const landuse of data.landuseEnum) {
    if (!(landuse in data.debugColours)) {
      fail(file, `debugColours.${landuse}`, 'is missing a debug colour for this landuse.')
    }
  }

  return data
}

/**
 * Validates settlements.json.
 *
 * @param {object} data Parsed settlements.json.
 * @returns {object} The same object, validated.
 */
function validateSettlements(data) {
  const file = 'settlements'

  for (const field of ['kinds', 'classSplitPercent', 'initialHousingCapacityFactor']) {
    requireField(data, field, file, '(root)')
  }

  data.kinds.forEach((kind, index) => {
    const context = `kinds[${index}]`
    for (const field of ['id', 'name', 'count', 'hinterlandRadiusMiles', 'initialPopulation']) {
      requireField(kind, field, file, context)
    }
  })

  for (const [key, split] of Object.entries(data.classSplitPercent)) {
    const total = split.upper + split.middle + split.working
    if (Math.abs(total - 100) > 0.5) {
      fail(file, `classSplitPercent.${key}`, `class percentages must sum to 100 (got ${total}).`)
    }
  }

  return data
}

/**
 * Validates names.json.
 *
 * @param {object} data Parsed names.json.
 * @returns {object} The same object, validated.
 */
function validateNames(data) {
  const file = 'names'

  for (const field of [
    'settlementStems', 'settlementEndings', 'coastalEndings', 'prefixes',
    'riverStems', 'riverSuffixes', 'bayStems', 'baySuffixes',
    'rangeStems', 'rangeSuffixes', 'islandNameStems', 'islandNameSuffixes', 'blocklist',
  ]) {
    requireField(data, field, file, '(root)')
  }

  return data
}

/**
 * Validates mapgen.json.
 *
 * @param {object} data Parsed mapgen.json.
 * @returns {object} The same object, validated.
 */
function validateMapgen(data) {
  const file = 'mapgen'

  for (const field of [
    'grid', 'islandMask', 'elevation', 'mountains', 'seaLevel', 'erosion',
    'climate', 'hydrology', 'slope', 'coast', 'soil', 'resources', 'links', 'validation',
  ]) {
    requireField(data, field, file, '(root)')
  }

  if (data.grid.width <= 0 || data.grid.height <= 0 || data.grid.cellMiles <= 0) {
    fail(file, 'grid', 'width, height and cellMiles must be positive.')
  }
  if (data.seaLevel.landFractionMin >= data.seaLevel.landFractionMax) {
    fail(file, 'seaLevel', 'landFractionMin must be less than landFractionMax.')
  }

  return data
}

/**
 * Recursively freezes an object graph so loaded rules can never be
 * mutated by simulation code.
 *
 * @param {*} value Any value; only objects and arrays are frozen.
 * @returns {*} The same value, frozen if it was an object.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key])
    }
  }
  return value
}

/**
 * Validates a raw set of parsed rules files and returns the frozen,
 * cross-referenced rules object used by the rest of the simulation.
 * Pure and synchronous, so it can be unit tested directly against
 * hand-built or deliberately broken fixtures without touching the
 * filesystem or network.
 *
 * @param {Record<string, object>} raw Map of file name (no extension) to its parsed JSON.
 * @returns {object} The validated, frozen rules.
 * @throws {RulesError} If any file is missing a required field, has an
 *   out-of-range value, an out-of-order table, or references an unknown
 *   cargo id.
 */
export function validateRules(raw) {
  for (const file of REQUIRED_FILES) {
    if (!(file in raw)) {
      fail(file, '(file)', 'is missing.')
    }
  }

  const cargo = validateCargo(raw.cargo)
  const cargoIds = new Set(cargo.map((entry) => entry.id))

  const rules = {
    client: raw.client,
    mapgen: validateMapgen(raw.mapgen),
    terrain: validateTerrain(raw.terrain),
    settlements: validateSettlements(raw.settlements),
    names: validateNames(raw.names),
    classes: validateClasses(raw.classes),
    cargo,
    industries: validateIndustries(raw.industries, cargoIds),
    economy: validateEconomy(raw.economy),
    difficulty: validateDifficulty(raw.difficulty),
    eras: validateEras(raw.eras),
    links: validateLinks(raw.links),
    vehicles: validateVehicles(raw.vehicles),
    ranks: validateRanks(raw.ranks),
    palette: raw.palette,
  }

  return deepFreeze(rules)
}

/**
 * Reads and JSON-parses every required rules file from a directory,
 * without validating them. Used by loadRulesNode() and directly by
 * tests that want a realistic fixture to mutate before calling
 * validateRules().
 *
 * @param {string} dataDir Path to the directory holding the JSON files (public/data).
 * @returns {Promise<Record<string, object>>} Map of file name to parsed JSON.
 * @throws {RulesError} If a file is missing from disk or is not valid JSON.
 */
export async function readRulesRawNode(dataDir) {
  const [{ readFile }, { join }] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ])

  const entries = await Promise.all(REQUIRED_FILES.map(async (file) => {
    const path = join(dataDir, `${file}.json`)
    let text

    try {
      text = await readFile(path, 'utf8')
    } catch {
      fail(file, '(file)', `could not be read at ${path}.`)
    }

    try {
      return [file, JSON.parse(text)]
    } catch (err) {
      fail(file, '(file)', `is not valid JSON: ${err.message}`)
    }
  }))

  return Object.fromEntries(entries)
}

/**
 * Loads and validates every rules file from disk. For Node contexts:
 * Vitest and scripts/balance.mjs.
 *
 * @param {string} dataDir Path to the directory holding the JSON files (public/data).
 * @returns {Promise<object>} The validated, frozen rules.
 */
export async function loadRulesNode(dataDir) {
  const raw = await readRulesRawNode(dataDir)
  return validateRules(raw)
}

/**
 * Loads and validates every rules file over HTTP. For the browser.
 *
 * @param {string} [baseUrl] Base path the files are served from.
 * @returns {Promise<object>} The validated, frozen rules.
 * @throws {RulesError} If a file fails to fetch.
 */
export async function loadRulesBrowser(baseUrl = '/data') {
  const entries = await Promise.all(REQUIRED_FILES.map(async (file) => {
    const response = await fetch(`${baseUrl}/${file}.json`)
    if (!response.ok) {
      fail(file, '(file)', `failed to fetch: HTTP ${response.status}`)
    }
    return [file, await response.json()]
  }))

  return validateRules(Object.fromEntries(entries))
}
