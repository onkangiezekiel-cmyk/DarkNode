import assert from 'node:assert/strict'
import test from 'node:test'
import { getMpesaTransactionStatus, requestMpesaDeposit, requestMpesaWithdrawal } from './mpesaPayments.ts'

function mockClient({ session = { access_token: 'user-session-token' }, response, invokeError, invokeErrors = [], invokeReject, invokeRejects = [] } = {}) {
  const calls = []
  return {
    calls,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
    functions: {
      invoke: async (...args) => {
        calls.push(args)
        const sequenceError = invokeRejects[calls.length - 1]
        if (sequenceError) throw sequenceError
        if (invokeReject) throw invokeReject
        const returnedError = invokeErrors[calls.length - 1]
        if (returnedError) return { data: null, error: returnedError }
        return { data: response, error: invokeError ?? null }
      },
    },
  }
}

test('calls the integrated deposit contract with an idempotency key and returns pending, not completed', async () => {
  const client = mockClient({
    response: {
      transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
      status: 'pending',
    },
  })
  const idempotencyKey = 'same-request-key-0001'

  const result = await requestMpesaDeposit(client, 100, '0712345678', idempotencyKey)

  assert.deepEqual(result, {
    id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
    status: 'pending',
  })
  assert.equal(client.calls.length, 1)
  const [slug, options] = client.calls[0]
  assert.equal(slug, 'mpesa-payments')
  assert.deepEqual(options.body, {
    idempotency_key: idempotencyKey,
    phone_number: '254712345678',
    amount_kes: 100,
  })
  assert.equal('headers' in options, false)
})

test('returns the stored amount when resuming an unresolved deposit', async () => {
  const client = mockClient({
    response: {
      transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
      status: 'pending',
      amount_kes: '500',
      reused: true,
    },
  })

  const result = await requestMpesaDeposit(client, 250, '0712345678', 'same-request-key-0001')

  assert.deepEqual(result, {
    id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
    status: 'pending',
    amountKes: 500,
    reused: true,
  })
})

test('retries a network failure with the same deposit idempotency key', async () => {
  const client = mockClient({
    response: { transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55', status: 'pending', reused: true },
    invokeRejects: [{
      name: 'FunctionsFetchError',
      message: 'Failed to send a request to the Edge Function.',
      context: new TypeError('Failed to fetch'),
    }],
  })
  const idempotencyKey = 'same-request-key-0001'

  const result = await requestMpesaDeposit(client, 100, '0712345678', idempotencyKey)

  assert.deepEqual(result, {
    id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
    status: 'pending',
    reused: true,
  })
  assert.equal(client.calls.length, 2)
  assert.deepEqual(client.calls[0], client.calls[1])
})

test('retries a returned FunctionsFetchError with the same deposit idempotency key', async () => {
  const client = mockClient({
    response: { transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55', status: 'pending', reused: true },
    invokeErrors: [{
      name: 'FunctionsFetchError',
      message: 'Failed to send a request to the Edge Function.',
      context: new TypeError('Failed to fetch'),
    }],
  })
  const idempotencyKey = 'same-request-key-0001'

  const result = await requestMpesaDeposit(client, 100, '0712345678', idempotencyKey)

  assert.deepEqual(result, {
    id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55',
    status: 'pending',
    reused: true,
  })
  assert.equal(client.calls.length, 2)
  assert.deepEqual(client.calls[0], client.calls[1])
})

test('does not retry a deposit more than once when transport failures persist', async () => {
  const fetchError = {
    name: 'FunctionsFetchError',
    message: 'Failed to send a request to the Edge Function.',
    context: new TypeError('Failed to fetch'),
  }
  const client = mockClient({ invokeErrors: [fetchError, fetchError] })
  const previousError = console.error
  console.error = () => {}

  try {
    await assert.rejects(
      requestMpesaDeposit(client, 100, '0712345678', 'same-request-key-0001'),
      /connection to the payment service was interrupted/,
    )
  } finally {
    console.error = previousError
  }
  assert.equal(client.calls.length, 2)
  assert.deepEqual(client.calls[0], client.calls[1])
})

test('does not treat a failed Daraja acknowledgement as a pending deposit', async () => {
  const client = mockClient({
    response: {
      success: false,
      provider: 'daraja',
      action: 'stk_push',
      result: { ResponseCode: '1', ResponseDescription: 'Rejected by provider' },
    },
  })

  await assert.rejects(
    requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'),
    /Rejected by provider/,
  )
})

test('rejects when there is no signed-in session without invoking the function', async () => {
  const client = mockClient({ session: null })

  await assert.rejects(
    requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'),
    /Sign in to Supabase/,
  )
  assert.equal(client.calls.length, 0)
})

test('rejects invalid whole-KES amounts before invoking the function', async () => {
  const client = mockClient({ response: { transaction_id: 'not-used', status: 'pending' } })

  await assert.rejects(requestMpesaDeposit(client, 100.5, '254712345678', 'same-request-key-0001'), /whole KES amount/)
  assert.equal(client.calls.length, 0)
})

test('rejects an invalid deposit idempotency key before invoking the function', async () => {
  const client = mockClient({ response: { transaction_id: 'not-used', status: 'pending' } })

  await assert.rejects(requestMpesaDeposit(client, 100, '254712345678', 'short'), /valid payment request key/)
  assert.equal(client.calls.length, 0)
})

test('surfaces backend HTTP errors from the invocation response body', async () => {
  const previousError = console.error
  const diagnostics = []
  console.error = (...args) => diagnostics.push(args)
  const client = mockClient({
    invokeError: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'Merchant configuration is not confirmed for phone 254712345678.' }), { status: 503 }),
    },
  })

  try {
    await assert.rejects(
      requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'),
      /Merchant configuration is not confirmed/,
    )
  } finally {
    console.error = previousError
  }
  assert.equal(diagnostics[0][1].type, 'FunctionsHttpError')
  assert.equal(diagnostics[0][1].status, 503)
  assert.match(diagnostics[0][1].responseBody.error, /\[redacted phone\]/)
  assert.doesNotMatch(JSON.stringify(diagnostics), /254712345678/)
})

test('surfaces an application error in a 200 response body', async () => {
  const client = mockClient({ response: { error: 'Deposit validation failed.' } })

  await assert.rejects(requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'), /Deposit validation failed/)
})

test('surfaces network failures without converting them into success', async () => {
  const previousError = console.error
  const diagnostics = []
  console.error = (...args) => diagnostics.push(args)
  const client = mockClient({
    invokeReject: {
      name: 'FunctionsFetchError',
      message: 'Failed to send a request to the Edge Function.',
      context: new TypeError('Failed to fetch'),
    },
  })

  try {
    await assert.rejects(requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'), /connection to the payment service was interrupted/)
  } finally {
    console.error = previousError
  }
  assert.equal(diagnostics[0][1].type, 'FunctionsFetchError')
  assert.equal(diagnostics[0][1].cause.name, 'TypeError')
  assert.equal(diagnostics[0][1].cause.message, 'Failed to fetch')
})

test('identifies relay errors distinctly', async () => {
  const previousError = console.error
  const diagnostics = []
  console.error = (...args) => diagnostics.push(args)
  const client = mockClient({
    invokeError: {
      name: 'FunctionsRelayError',
      message: 'Relay failed.',
    },
  })

  try {
    await assert.rejects(requestMpesaDeposit(client, 100, '254712345678', 'same-request-key-0001'), /Relay failed/)
  } finally {
    console.error = previousError
  }
  assert.equal(diagnostics[0][1].type, 'FunctionsRelayError')
})

test('submits withdrawals with an idempotency key and no browser-side server secret', async () => {
  const client = mockClient({
    response: { transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55', status: 'submitted', balance: 750 },
  })
  const idempotencyKey = 'same-request-key-0001'

  const result = await requestMpesaWithdrawal(client, 250, '0712345678', idempotencyKey)

  assert.deepEqual(result, { id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55', status: 'submitted', balance: 750 })
  assert.equal(client.calls[0][0], 'mpesa-withdrawal')
  assert.deepEqual(client.calls[0][1], {
    body: { amount: 250, amount_kes: 250, phone_number: '254712345678', phone: '254712345678' },
    headers: { 'idempotency-key': idempotencyKey },
  })
})

test('rejects a withdrawal response without an authoritative wallet balance', async () => {
  const client = mockClient({
    response: { transaction_id: '4a95a449-0b19-4c39-a10a-8cc69ee05a55', status: 'submitted' },
  })

  await assert.rejects(
    requestMpesaWithdrawal(client, 250, '0712345678', 'same-request-key-0001'),
    /invalid withdrawal balance/i,
  )
})

test('loads only a valid transaction status response for the requested transaction', async () => {
  const id = '4a95a449-0b19-4c39-a10a-8cc69ee05a55'
  const client = mockClient({
    response: {
      transaction_id: id,
      transaction_type: 'deposit',
      status: 'succeeded',
      amount_kes: 100,
      currency: 'KES',
      receipt_number: 'QWE12345',
      created_at: '2026-10-20T00:00:00Z',
      completed_at: '2026-10-20T00:01:00Z',
      balance: 1100,
    },
  })

  assert.deepEqual(await getMpesaTransactionStatus(client, id), {
    id,
    type: 'deposit',
    status: 'succeeded',
    amountKes: 100,
    currency: 'KES',
    receiptNumber: 'QWE12345',
    createdAt: '2026-10-20T00:00:00Z',
    completedAt: '2026-10-20T00:01:00Z',
    balance: 1100,
  })
  assert.equal(client.calls[0][0], 'transaction-status')
})

test('does not invoke status endpoint for malformed or cross-transaction response IDs', async () => {
  const client = mockClient({
    response: { transaction_id: 'other', transaction_type: 'deposit', status: 'succeeded' },
  })
  await assert.rejects(
    getMpesaTransactionStatus(client, '4a95a449-0b19-4c39-a10a-8cc69ee05a55'),
    /invalid transaction status/,
  )
})
