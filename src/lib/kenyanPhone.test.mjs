import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeKenyanPhone } from './kenyanPhone.ts'

test('normalizes Kenyan 01 and 07 local and international formats', () => {
  for (const [phone, expected] of [
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254712345678', '254712345678'],
    ['+254112345678', '254112345678'],
    ['254712345678', '254712345678'],
    ['254112345678', '254112345678'],
    ['+254 712-345-678', '254712345678'],
    ['01 (12) 345 678', '254112345678'],
  ]) {
    assert.equal(normalizeKenyanPhone(phone), expected, phone)
  }
})

test('rejects invalid Kenyan mobile numbers', () => {
  for (const phone of ['', '071234567', '254212345678', '+2547123456789', '25471234567a']) {
    assert.throws(() => normalizeKenyanPhone(phone), /valid Kenyan mobile number/)
  }
})
