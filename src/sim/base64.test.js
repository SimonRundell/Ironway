import { describe, expect, it } from 'vitest'
import { base64ToUint8Array, uint8ArrayToBase64 } from './base64.js'

describe('uint8ArrayToBase64 / base64ToUint8Array', () => {
  it('round-trips an empty array', () => {
    const bytes = new Uint8Array(0)
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it('round-trips a small array', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64])
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it('round-trips an array larger than one chunk', () => {
    const bytes = new Uint8Array(20000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it('round-trips a size that does not divide the chunk size evenly', () => {
    const bytes = new Uint8Array(8193)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })
})
