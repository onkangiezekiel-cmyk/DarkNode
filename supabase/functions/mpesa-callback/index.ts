import { handleOptions, jsonResponse, safeErrorResponse, HttpError } from '../_shared/http.ts'
import {
  asRecord,
  getDarajaEnvironment,
  normalizeKenyanPhone,
  safeProviderDescription,
  stkQuery,
  verifyCallbackToken,
} from '../_shared/mpesa.js'
import { getAdminClient } from '../_shared/supabase.ts'

function callbackItems(value: unknown): Record<string, unknown> {
  const body = asRecord(value)
  const callback = asRecord(body?.Body)
  const stkCallback = asRecord(callback?.stkCallback)
  if (!stkCallback) throw new HttpError('Invalid STK callback.', 400)
  return stkCallback
}

function callbackMetadata(value: unknown): Record<string, unknown> {
  const metadata = asRecord(value)
  const items = Array.isArray(metadata?.Item) ? metadata.Item : []
  return Object.fromEntries(items.flatMap((entry) => {
    const item = asRecord(entry)
    return item && typeof item.Name === 'string' ? [[item.Name, item.Value]] : []
  }))
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, request)

  try {
    verifyCallbackToken(request, 'MPESA_CALLBACK_TOKEN')
    getDarajaEnvironment(true)
    const callback = callbackItems(await request.json())
    const checkoutId = typeof callback.CheckoutRequestID === 'string' ? callback.CheckoutRequestID : ''
    const callbackResultCode = Number(callback.ResultCode)
    if (!checkoutId || !Number.isInteger(callbackResultCode)) {
      throw new HttpError('Callback is missing a valid checkout request result.', 400)
    }

    const admin = getAdminClient()
    let stored: { id: string; amount_kes: number; phone_number: string; status: string } | null = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data, error: lookupError } = await admin
        .from('mpesa_transactions')
        .select('id, amount_kes, phone_number, status')
        .eq('checkout_request_id', checkoutId)
        .eq('transaction_type', 'deposit')
        .maybeSingle()
      if (lookupError) throw lookupError
      if (data) {
        stored = data
        break
      }
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!stored) {
      return jsonResponse({ error: 'Deposit transaction is not recorded yet. Retry callback processing.' }, 503, request)
    }
    if (stored.status === 'succeeded') return jsonResponse({ received: true, status: 'succeeded' }, 200, request)

    let query: Record<string, unknown>
    try {
      query = await stkQuery(checkoutId, true)
    } catch {
      return jsonResponse({ error: 'Provider status could not be verified. Retry callback processing.' }, 503, request)
    }

    if (String(query.ResponseCode ?? '') !== '0' || !('ResultCode' in query)) {
      const { error } = await admin.rpc('apply_mpesa_deposit_callback', {
        p_checkout_request_id: checkoutId,
        p_verified_status: 'reconciliation',
        p_verified: false,
        p_amount_kes: null,
        p_receipt_number: null,
        p_phone_number: null,
        p_result_code: String(query.ResultCode ?? ''),
        p_result_description: safeProviderDescription(query.ResultDesc),
      })
      if (error) throw error
      return jsonResponse({ received: true, status: 'reconciliation' }, 202, request)
    }

    const queryResultCode = Number(query.ResultCode)
    if (!Number.isInteger(queryResultCode) || queryResultCode !== callbackResultCode) {
      const { error } = await admin.rpc('apply_mpesa_deposit_callback', {
        p_checkout_request_id: checkoutId,
        p_verified_status: 'reconciliation',
        p_verified: false,
        p_amount_kes: null,
        p_receipt_number: null,
        p_phone_number: null,
        p_result_code: String(query.ResultCode ?? ''),
        p_result_description: 'Callback and provider query results do not match.',
      })
      if (error) throw error
      return jsonResponse({ received: true, status: 'reconciliation' }, 202, request)
    }

    const success = queryResultCode === 0
    const metadata = callbackMetadata(callback.CallbackMetadata)
    let amount: number | null = null
    let receipt: string | null = null
    let phone: string | null = null
    if (success) {
      const rawAmount = metadata.Amount
      amount = typeof rawAmount === 'number'
        ? rawAmount
        : typeof rawAmount === 'string' && /^\d+$/.test(rawAmount)
          ? Number(rawAmount)
          : null
      receipt = typeof metadata.MpesaReceiptNumber === 'string' ? metadata.MpesaReceiptNumber : null
      try {
        phone = normalizeKenyanPhone(String(metadata.PhoneNumber ?? ''))
      } catch {
        phone = null
      }
    }
    const resultStatus = queryResultCode === 4999
      ? 'pending'
      : queryResultCode === 1032
        ? 'cancelled'
        : queryResultCode === 1037
          ? 'timed_out'
          : 'failed'
    const { data, error } = await admin.rpc('apply_mpesa_deposit_callback', {
      p_checkout_request_id: checkoutId,
      p_verified_status: success ? 'succeeded' : resultStatus,
      p_verified: true,
      p_amount_kes: amount,
      p_receipt_number: receipt,
      p_phone_number: phone,
      p_result_code: String(queryResultCode),
      p_result_description: safeProviderDescription(query.ResultDesc),
    })
    if (error) throw error
    return jsonResponse({ received: true, status: data?.[0]?.transaction_status ?? 'reconciliation' }, 200, request)
  } catch (error) {
    return safeErrorResponse(error, request)
  }
})
