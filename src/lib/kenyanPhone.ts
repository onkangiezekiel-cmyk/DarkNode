export function normalizeKenyanPhone(input: string): string {
  const compact = input.trim().replace(/[\s().-]/g, '')
  if (/^0[17]\d{8}$/.test(compact)) return `254${compact.slice(1)}`
  if (/^\+254[17]\d{8}$/.test(compact)) return compact.slice(1)
  if (/^254[17]\d{8}$/.test(compact)) return compact
  throw new Error('Use a valid Kenyan mobile number starting with 01, 07, +2541, +2547, 2541, or 2547.')
}
