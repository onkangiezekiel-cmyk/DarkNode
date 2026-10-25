import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, RefreshCw, Smartphone, XCircle } from 'lucide-react'
import Modal from './Modal'
import DemoNotice from './DemoNotice'
import { getMpesaTransactionStatus, requestMpesaDeposit, requestMpesaWithdrawal, type MpesaTransactionStatus } from '../lib/mpesaPayments'
import { normalizeKenyanPhone } from '../lib/kenyanPhone'
import { supabase } from '../lib/supabase'

type PaymentAction = 'deposit' | 'withdraw'

type MpesaPaymentModalProps = {
  action: PaymentAction
  balance: number
  balanceLoaded: boolean
  profilePhone: string
  backendMode: boolean
  onClose: () => void
  onWalletRefresh: () => Promise<void>
  onWalletBalanceChange: (balance: number) => void
}

type UnresolvedDepositAttempt = {
  amount: number
  idempotencyKey: string
  phone: string
}

const unresolvedDepositStorageKey = 'darknode:mpesa:unresolved-deposit'

function readUnresolvedDepositAttempt(profilePhone: string): UnresolvedDepositAttempt | null {
  try {
    const stored = sessionStorage.getItem(unresolvedDepositStorageKey)
    if (!stored) return null
    const attempt: unknown = JSON.parse(stored)
    if (
      typeof attempt !== 'object'
      || attempt === null
      || !('amount' in attempt)
      || !('idempotencyKey' in attempt)
      || !('phone' in attempt)
      || typeof attempt.amount !== 'number'
      || !Number.isSafeInteger(attempt.amount)
      || attempt.amount < 1
      || attempt.amount > 150_000
      || typeof attempt.idempotencyKey !== 'string'
      || attempt.idempotencyKey.length < 16
      || attempt.idempotencyKey.length > 128
      || typeof attempt.phone !== 'string'
      || normalizeKenyanPhone(attempt.phone) !== normalizeKenyanPhone(profilePhone)
    ) {
      return null
    }
    return {
      amount: attempt.amount,
      idempotencyKey: attempt.idempotencyKey,
      phone: normalizeKenyanPhone(attempt.phone),
    }
  } catch {
    return null
  }
}

function persistUnresolvedDepositAttempt(attempt: UnresolvedDepositAttempt): void {
  try {
    sessionStorage.setItem(unresolvedDepositStorageKey, JSON.stringify(attempt))
  } catch {
    // The same-key retry still works while this modal remains mounted.
  }
}

function clearUnresolvedDepositAttempt(idempotencyKey: string): void {
  try {
    const stored = sessionStorage.getItem(unresolvedDepositStorageKey)
    if (!stored) return
    const attempt: unknown = JSON.parse(stored)
    if (
      typeof attempt === 'object'
      && attempt !== null
      && 'idempotencyKey' in attempt
      && attempt.idempotencyKey === idempotencyKey
    ) {
      sessionStorage.removeItem(unresolvedDepositStorageKey)
    }
  } catch {
    sessionStorage.removeItem(unresolvedDepositStorageKey)
  }
}

function formatKes(value: number): string {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function statusLabel(status: MpesaTransactionStatus['status']): string {
  switch (status) {
    case 'succeeded': return 'Completed'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    case 'timed_out': return 'Timed out'
    case 'reconciliation': return 'Under review'
    case 'submitted': return 'Processing'
    case 'reserved': return 'Processing'
    case 'initiating': return 'Starting'
    default: return 'Awaiting confirmation'
  }
}

export default function MpesaPaymentModal({
  action,
  balance,
  balanceLoaded,
  profilePhone,
  backendMode,
  onClose,
  onWalletRefresh,
  onWalletBalanceChange,
}: MpesaPaymentModalProps) {
  const isDeposit = action === 'deposit'
  const restoredAttempt = isDeposit ? readUnresolvedDepositAttempt(profilePhone) : null
  const [amount, setAmount] = useState(restoredAttempt ? String(restoredAttempt.amount) : '')
  const [transaction, setTransaction] = useState<MpesaTransactionStatus | null>(null)
  const [error, setError] = useState(restoredAttempt
    ? 'A previous deposit request may still be processing. Retrying will reuse the same request key.'
    : '')
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [requestStarted, setRequestStarted] = useState(Boolean(restoredAttempt))
  const idempotencyKey = useRef<string | null>(restoredAttempt?.idempotencyKey ?? null)

  const startPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    let phone: string
    try {
      phone = normalizeKenyanPhone(profilePhone)
    } catch {
      setError('Add a valid Kenyan mobile number to your account profile before continuing.')
      return
    }
    const amountKes = Number(amount)
    if (!Number.isSafeInteger(amountKes) || amountKes < 1 || amountKes > 150_000) {
      setError('Enter a whole KES amount between KES 1 and KES 150,000.')
      return
    }
    if (!isDeposit && (!balanceLoaded || amountKes > balance)) {
      setError(balanceLoaded ? 'The withdrawal amount exceeds your available balance.' : 'Your wallet balance is not available yet.')
      return
    }
    if (!backendMode || !supabase) {
      setError('Connect the authenticated Supabase account before using M-Pesa.')
      return
    }

    const requestKey = idempotencyKey.current ?? crypto.randomUUID()
    idempotencyKey.current = requestKey
    if (isDeposit) {
      persistUnresolvedDepositAttempt({
        amount: amountKes,
        idempotencyKey: requestKey,
        phone,
      })
    }
    setRequestStarted(true)
    setSubmitting(true)
    try {
      const result = isDeposit
        ? await requestMpesaDeposit(supabase, amountKes, phone, requestKey)
        : await requestMpesaWithdrawal(supabase, amountKes, phone, requestKey)
      setTransaction({
        id: result.id,
        type: isDeposit ? 'deposit' : 'withdrawal',
        status: result.status,
        amountKes: result.amountKes ?? amountKes,
        currency: 'KES',
        receiptNumber: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        balance: result.balance ?? balance,
        statusCheckAvailable: result.statusCheckAvailable ?? true,
      })
      if (result.balance !== undefined) onWalletBalanceChange(result.balance)
      if (isDeposit && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(result.status)) {
        clearUnresolvedDepositAttempt(requestKey)
      }
    } catch (requestError) {
      console.error('Could not submit the M-Pesa request.', requestError)
      setError('We could not submit your M-Pesa request. Please try again shortly.')
    } finally {
      setSubmitting(false)
    }
  }

  const refreshStatus = useCallback(async () => {
    if (!transaction || !supabase) return
    setChecking(true)
    setError('')
    try {
      const latest = await getMpesaTransactionStatus(supabase, transaction.id)
      setTransaction(latest)
      onWalletBalanceChange(latest.balance)
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(latest.status)) {
        if (isDeposit && idempotencyKey.current) {
          clearUnresolvedDepositAttempt(idempotencyKey.current)
        }
        try {
          await onWalletRefresh()
        } catch {
          setError('Transaction status is current, but wallet activity could not be refreshed.')
        }
      }
    } catch (statusError) {
      console.error('Could not check the M-Pesa transaction status.', statusError)
      setError('We could not check the payment status right now. Please try again.')
    } finally {
      setChecking(false)
    }
  }, [isDeposit, onWalletBalanceChange, onWalletRefresh, transaction])

  const refreshStatusRef = useRef(refreshStatus)
  useEffect(() => {
    refreshStatusRef.current = refreshStatus
  }, [refreshStatus])

  useEffect(() => {
    if (!transaction || transaction.statusCheckAvailable === false) return
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(transaction.status) || checking) return
    const timer = window.setTimeout(() => void refreshStatusRef.current(), 10_000)
    return () => window.clearTimeout(timer)
  }, [checking, transaction])

  const resetForm = () => {
    if (isDeposit && idempotencyKey.current) {
      clearUnresolvedDepositAttempt(idempotencyKey.current)
    }
    setTransaction(null)
    setError('')
    setAmount('')
    setRequestStarted(false)
    idempotencyKey.current = null
  }

  const terminal = transaction && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(transaction.status)
  const statusIcon = transaction?.status === 'succeeded'
    ? <CheckCircle2 size={22} />
    : transaction && ['failed', 'cancelled'].includes(transaction.status)
      ? <XCircle size={22} />
      : transaction?.status === 'reconciliation'
        ? <AlertCircle size={22} />
        : <Clock3 size={22} />

  return (
    <Modal title={isDeposit ? 'Deposit Funds' : 'Withdraw Funds'} onClose={onClose} className="account-modal mpesa-payment-modal">
      <div className="account-panel-body mpesa-payment">
        <div className="available-balance">
          <span>{isDeposit ? 'Current balance' : 'Available balance'}</span>
          <strong>{balanceLoaded ? formatKes(balance) : 'Balance unavailable'}</strong>
        </div>

        {!backendMode && (
          <DemoNotice>Payments are not available in browser-demo mode. No transaction will be created.</DemoNotice>
        )}

        {!transaction && backendMode && (
          <form onSubmit={startPayment}>
            <label className="field-label" htmlFor="mpesa-payment-phone">Registered mobile number</label>
            <input
              id="mpesa-payment-phone"
              className="form-input"
              type="tel"
              autoComplete="tel"
              readOnly
              disabled={requestStarted}
              value={profilePhone === 'Not provided' ? '' : profilePhone}
              placeholder="No mobile number on your account"
            />
            <label className="field-label" htmlFor="mpesa-payment-amount">
              Amount to {isDeposit ? 'deposit' : 'withdraw'} (KES)
            </label>
            <input
              id="mpesa-payment-amount"
              className="form-input"
              type="number"
              min="1"
              max="150000"
              step="1"
              inputMode="numeric"
              required
              disabled={requestStarted}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {error && <p className="mpesa-payment-error" role="alert"><AlertCircle size={15} />{error}</p>}
            {!isDeposit && (
              <p className="mpesa-payment-note">
                Verify the recipient number carefully. Withdrawals require Safaricom-approved B2C production access and remain pending until the provider confirms the outcome.
              </p>
            )}
            <button className="primary-button full-button" type="submit" disabled={submitting || (isDeposit && requestStarted && !error) || (!isDeposit && !balanceLoaded)}>
              {submitting
                ? <><LoaderCircle className="mpesa-spinner" size={16} /> Submitting…</>
                : <><Smartphone size={16} /> {requestStarted && error ? 'Retry same request' : isDeposit ? 'Send M-Pesa prompt' : 'Request withdrawal'}</>}
            </button>
            {requestStarted && !transaction && (
              <p className="mpesa-payment-note">
                {isDeposit
                  ? 'A retry uses the same request key and will not create a duplicate STK request. If a prompt already arrived, handle that prompt before retrying.'
                  : 'This retry uses the same idempotency key. Do not change the amount or start another request while the result is unknown.'}
              </p>
            )}
          </form>
        )}

        {transaction && (
          <div className="mpesa-payment-status">
            <span className={`mpesa-status-icon ${transaction.status}`}>{statusIcon}</span>
            <h3>{statusLabel(transaction.status)}</h3>
            <p>
              {transaction.status === 'succeeded'
                ? isDeposit ? 'The deposit was confirmed by the payment service.' : 'The withdrawal was confirmed by the payment service.'
                : transaction.status === 'reconciliation'
                  ? 'The provider result is uncertain. Funds, if reserved, remain held until reconciliation. Do not submit another withdrawal.'
                  : transaction.status === 'failed' || transaction.status === 'cancelled' || transaction.status === 'timed_out'
                    ? 'The payment was not confirmed as successful. Check your wallet history before trying again.'
                    : isDeposit
                      ? transaction.statusCheckAvailable === false
                        ? 'The STK prompt was accepted. Approve it on your phone. This payment endpoint does not provide transaction-status lookup or confirm wallet credit.'
                        : 'Approve the M-Pesa prompt on your phone. Your wallet is credited only after the server verifies the payment.'
                      : 'Your request is pending. Your available balance has not been updated optimistically.'}
            </p>
            <div className="mpesa-status-summary">
              <span>Amount</span><strong>{formatKes(transaction.amountKes)}</strong>
              <span>Reference</span><code>{transaction.id}</code>
              {transaction.receiptNumber && <><span>M-Pesa receipt</span><strong>{transaction.receiptNumber}</strong></>}
              {transaction.completedAt && <><span>Updated</span><strong>{new Date(transaction.completedAt).toLocaleString('en-KE')}</strong></>}
            </div>
            {error && <p className="mpesa-payment-error" role="alert"><AlertCircle size={15} />{error}</p>}
            {!terminal && transaction.statusCheckAvailable !== false && (
              <>
                <button className="outline-button full-button" type="button" onClick={() => void refreshStatus()} disabled={checking}>
                  {checking ? <><LoaderCircle className="mpesa-spinner" size={15} /> Checking…</> : <><RefreshCw size={15} /> Refresh status</>}
                </button>
                <p className="mpesa-payment-note">Status refreshes automatically while this payment window is open.</p>
              </>
            )}
            {transaction.statusCheckAvailable === false && (
              <p className="mpesa-payment-note">The current payment endpoint cannot refresh this checkout status. Check the wallet through a trusted backend transaction-history flow before assuming funds were credited.</p>
            )}
            {transaction.status === 'reconciliation' && (
              <p className="mpesa-payment-note">If this status does not change, contact support with the reference above. Do not retry the request.</p>
            )}
            {terminal && transaction.status !== 'succeeded' && (
              <button className="outline-button full-button" type="button" onClick={resetForm}>Start another request</button>
            )}
            <button className="primary-button full-button" type="button" onClick={onClose}>
              {transaction.status === 'succeeded' ? 'Return to wallet' : 'Close'}
            </button>
          </div>
        )}

        {!backendMode && (
          <button className="primary-button full-button" type="button" onClick={onClose}>Close</button>
        )}
      </div>
    </Modal>
  )
}
