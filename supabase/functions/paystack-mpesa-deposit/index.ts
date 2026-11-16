const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

type JsonRecord = Record<string, unknown>

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new HttpError(`The ${name} function secret is not configured.`, 500)
  return value
}

function normalizeKenyanPhone(input: string): string {
  const compact = input.trim().replace(/[\s().-]/g, '')
  if (/^0[17]\d{8}$/.test(compact)) return `+254${compact.slice(1)}`
  if (/^\+254[17]\d{8}$/.test(compact)) return compact
  if (/^254[17]\d{8}$/.test(compact)) return `+${compact}`
  throw new HttpError('The registered phone number is not a valid Kenyan mobile number.', 400)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new HttpError('A payment provider returned an invalid response.', 502)
  }
}

async function authenticate(request: Request): Promise<{ id: string; email: string; phoneNumber?: string }> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) throw new HttpError('Sign in before starting a deposit.', 401)

  const baseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
    || Deno.env.get('SUPABASE_PUBLISHABLE_KEY')?.trim()
  if (!anonKey) throw new HttpError('Supabase publishable key is not configured for this function.', 500)

  const response = await fetch(`${baseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
  })
  const user = await readJson(response)
  if (!response.ok || !isRecord(user) || typeof user.id !== 'string' || typeof user.email !== 'string') {
    throw new HttpError('Your sign-in session is invalid. Sign in again.', 401)
  }
  const userMetadata = isRecord(user.user_metadata) ? user.user_metadata : null
  return {
    id: user.id,
    email: user.email,
    ...(typeof userMetadata?.phone_number === 'string' ? { phoneNumber: userMetadata.phone_number } : {}),
  }
}

async function getRegisteredPhone(userId: string, authPhone?: string): Promise<string> {
  const baseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '')
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  const query = new URLSearchParams({ select: 'phone_number', user_id: `eq.${userId}` })
  const response = await fetch(`${baseUrl}/rest/v1/profiles?${query}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })
  const rows = await readJson(response)
  if (!response.ok || !Array.isArray(rows)) {
    throw new HttpError('Could not load the registered phone number for this account.', 400)
  }
  const storedPhone = isRecord(rows[0]) && typeof rows[0].phone_number === 'string'
    ? rows[0].phone_number.trim()
    : ''
  const phone = storedPhone && storedPhone.toLowerCase() !== 'not provided' ? storedPhone : authPhone
  if (!phone) throw new HttpError('Add a valid Kenyan mobile number to your account profile before making a deposit.', 400)
  return normalizeKenyanPhone(phone)
}

async function startCharge(
  user: { id: string; email: string },
  amountValue: unknown,
): Promise<JsonRecord> {
  const amount = Number(amountValue)
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000000) {
    throw new HttpError('Enter a deposit amount between KSh 1 and KSh 10,000,000.', 400)
  }
  const amountMinorUnits = Math.round(amount * 100)
  if (!Number.isSafeInteger(amountMinorUnits) || amountMinorUnits < 100) {
    throw new HttpError('The deposit amount must be at least KSh 1.', 400)
  }

  const phone = await getRegisteredPhone(user.id, user.phoneNumber)
  const secretKey = requiredEnv('PAYSTACK_SECRET_KEY')
  const response = await fetch('https://api.paystack.co/charge', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: String(amountMinorUnits),
      currency: 'KES',
      mobile_money: { phone, provider: 'mpesa' },
      reference: crypto.randomUUID(),
      metadata: {
        source: 'darknode_wallet_mpesa',
        user_id: user.id,
        amount_kes: (amountMinorUnits / 100).toFixed(2),
      },
    }),
  })
  const result = await readJson(response)
  if (!response.ok || !isRecord(result) || result.status !== true || !isRecord(result.data)) {
    const message = isRecord(result) && typeof result.message === 'string'
      ? result.message
      : 'Paystack could not start the M-Pesa payment.'
    throw new HttpError(message, 502)
  }
  if (typeof result.data.reference !== 'string') {
    throw new HttpError('Paystack did not return a payment reference.', 502)
  }

  return {
    reference: result.data.reference,
    status: 'pending',
    message: typeof result.data.display_text === 'string'
      ? result.data.display_text
      : 'M-Pesa prompt sent. Approve the payment on your phone.',
  }
}

async function verifyCharge(userId: string, referenceValue: unknown): Promise<JsonRecord> {
  if (typeof referenceValue !== 'string' || !/^[A-Za-z0-9._=-]{1,100}$/.test(referenceValue)) {
    throw new HttpError('The Paystack payment reference is invalid.', 400)
  }

  const secretKey = requiredEnv('PAYSTACK_SECRET_KEY')
  const response = await fetch(`https://api.paystack.co/charge/${encodeURIComponent(referenceValue)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  })
  const chargeResult = await readJson(response)
  if (!response.ok || !isRecord(chargeResult) || chargeResult.status !== true || !isRecord(chargeResult.data)) {
    throw new HttpError('Could not check the M-Pesa payment with Paystack.', 502)
  }

  const charge = chargeResult.data
  const transactionStatus = charge.status
  if (transactionStatus === 'pending' || transactionStatus === 'ongoing' || transactionStatus === 'processing') {
    return { status: 'pending', message: 'Waiting for M-Pesa confirmation on your phone.' }
  }
  if (transactionStatus !== 'success') {
    return {
      status: 'failed',
      message: typeof charge.gateway_response === 'string'
        ? charge.gateway_response
        : 'The M-Pesa payment was not completed.',
    }
  }

  const verificationResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(referenceValue)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  })
  const verificationResult = await readJson(verificationResponse)
  if (
    !verificationResponse.ok
    || !isRecord(verificationResult)
    || verificationResult.status !== true
    || !isRecord(verificationResult.data)
  ) {
    throw new HttpError('Could not verify the M-Pesa payment with Paystack.', 502)
  }

  const transaction = verificationResult.data
  const metadata = transaction.metadata
  const amountMinorUnits = Number(transaction.amount)
  const expectedAmountMinorUnits = isRecord(metadata) ? Number(metadata.amount_kes) * 100 : NaN
  if (
    transaction.reference !== referenceValue
    || transaction.currency !== 'KES'
    || !isRecord(metadata)
    || metadata.source !== 'darknode_wallet_mpesa'
    || metadata.user_id !== userId
    || !Number.isSafeInteger(amountMinorUnits)
    || amountMinorUnits <= 0
    || Math.round(expectedAmountMinorUnits) !== amountMinorUnits
  ) {
    throw new HttpError('The verified payment does not match this account and deposit amount.', 403)
  }

  const baseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '')
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  const creditResponse = await fetch(`${baseUrl}/rest/v1/rpc/credit_paystack_mpesa_deposit`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_reference: referenceValue,
      p_amount: (amountMinorUnits / 100).toFixed(2),
    }),
  })
  if (!creditResponse.ok) {
    throw new HttpError('The payment succeeded, but the wallet could not be updated. Retry verification or contact support.', 500)
  }

  return { status: 'success', message: 'Deposit confirmed. Your wallet has been credited.' }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return jsonResponse({ error: 'Use POST for deposit requests.' }, 405)

  try {
    const user = await authenticate(request)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new HttpError('The deposit request must contain valid JSON.', 400)
    }
    if (!isRecord(body)) throw new HttpError('The deposit request is invalid.', 400)

    if (body.action === 'charge') return jsonResponse(await startCharge(user, body.amount))
    if (body.action === 'verify') return jsonResponse(await verifyCharge(user.id, body.reference))
    throw new HttpError('Choose a valid deposit action.', 400)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : 'The M-Pesa deposit request failed.'
    if (status >= 500) console.error('M-Pesa deposit function failed.', error)
    return jsonResponse({ error: message }, status)
  }
})
