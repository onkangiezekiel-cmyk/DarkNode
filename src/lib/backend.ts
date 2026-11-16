import type { Auction, AuctionProgress, AccountTransaction, Holding, LoanApplication, RewardRecord, UserProfile } from '../types'
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase'
import { resolveAccountDisplayDetails } from './profileDisplay'
import { isNetworkFetchFailure, parseAuctionBidRpcResult, parseInvestmentReturnSwapResult, parseInvestmentRpcResult, retryNetworkRead } from './backendRpc'
import { calculateInvestmentReturn } from './investmentReturns'

type AssetPerformance = ReturnType<typeof calculateInvestmentReturn>
type InvestmentPositionRow = {
  id: string
  symbol: string
  company: string
  shares: number
  amount_charged: number
  daily_return_percent?: number | null
  returns_paid?: number | null
  created_at: string
  expires_at: string
}

export type BackendAccount = {
  profile: UserProfile
  purchases: Holding[]
  performance: Record<string, AssetPerformance>
  cooldowns: Record<string, number>
  transactions: AccountTransaction[]
  loans: LoanApplication[]
  rewards: RewardRecord[]
  firstInvestmentOfferUsed: boolean
  investmentReturnsEnabled: boolean
}

export function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured.')
  return supabase
}

function queryError(label: string, error: { code?: string; message?: string; details?: string; hint?: string }) {
  const code = error.code ? ` (${error.code})` : ''
  const detail = error.message || 'Unknown database error.'
  const migrationHint = error.code === '42P01' || error.code === 'PGRST205'
    ? ' Apply all SQL files in supabase/migrations in timestamp order.'
    : ''
  const extra = [error.details, error.hint].filter(Boolean).join(' ')
  return new Error(`${label}${code}: ${detail}${extra ? ` ${extra}` : ''}${migrationHint}`)
}

export async function loadBackendAccount(
  userId: string,
  authProfile?: { email?: string; fullName?: unknown; phoneNumber?: unknown },
): Promise<BackendAccount> {
  const client = requireSupabase()
  const [profileResult, initialPositionsResult, transactionsResult, loansResult, rewardsResult, paymentRequestsResult] = await Promise.all([
    client.from('profiles').select('full_name, phone_number, referral_code, referred_by, first_investment_discount_used').eq('user_id', userId).maybeSingle(),
    client.from('investment_positions').select('id, symbol, company, shares, amount_charged, daily_return_percent, returns_paid, created_at, expires_at').eq('user_id', userId).order('created_at', { ascending: false }),
    client.from('wallet_transactions').select('id, category, description, amount, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    client.from('loan_applications').select('id, amount, duration_months, status, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    client.from('reward_events').select('id, reward_type, title, detail, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    client.from('payment_requests').select('id, request_type, amount, phone_number, status, created_at').eq('user_id', userId).eq('request_type', 'withdraw').order('created_at', { ascending: false }),
  ])

  let positionRows: InvestmentPositionRow[] = initialPositionsResult.data ?? []
  let positionsError = initialPositionsResult.error
  let investmentReturnsEnabled = !positionsError
  if (positionsError?.code === '42703') {
    investmentReturnsEnabled = false
    console.error(
      'Investment return columns are missing. Apply supabase/migrations/202610190001_investment_returns.sql to enable persistent return tracking and wallet transfers.',
      positionsError,
    )
    const legacyPositionsResult = await client.from('investment_positions')
      .select('id, symbol, company, shares, amount_charged, created_at, expires_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    positionsError = legacyPositionsResult.error
    positionRows = legacyPositionsResult.data ?? []
  }
  investmentReturnsEnabled = !positionsError && positionRows.every((position) => {
    const dailyReturnPercent = Number(position.daily_return_percent)
    return Number.isFinite(dailyReturnPercent) && dailyReturnPercent >= 9 && dailyReturnPercent <= 12
  })

  const requiredResults = [
    ['Profile', profileResult],
    ['Investment history', { error: positionsError }],
    ['Wallet transaction history', transactionsResult],
    ['Loan history', loansResult],
    ['Reward history', rewardsResult],
    ['Payment request history', paymentRequestsResult],
  ] as const
  for (const [label, result] of requiredResults) {
    if (result.error) throw queryError(`Could not load ${label.toLowerCase()}`, result.error)
  }
  if (!profileResult.data) throw new Error('The account profile was not created. Run the Supabase migration and try again.')

  const profile = profileResult.data
  const displayDetails = resolveAccountDisplayDetails({
    fullName: profile.full_name,
    phoneNumber: profile.phone_number,
  }, authProfile)
  const now = Date.now()
  const allPurchases: Holding[] = positionRows.map((position) => ({
    symbol: position.symbol,
    company: position.company,
    percent: 0,
    shares: Number(position.shares),
    value: Number(position.amount_charged),
    gain: 0,
    investmentId: position.id,
    startedAt: new Date(position.created_at).getTime(),
    expiresAt: new Date(position.expires_at).getTime(),
    ...(Number.isFinite(Number(position.daily_return_percent))
      ? { dailyReturnPercent: Number(position.daily_return_percent) }
      : {}),
    ...(Number.isFinite(Number(position.returns_paid))
      ? { returnsPaid: Number(position.returns_paid) }
      : {}),
  }))
  const purchases = allPurchases.filter((purchase) => {
    const progress = calculateInvestmentReturn(purchase, now)
    return progress.remainingMs > 0 || progress.claimableGain > 0
  })
  const performance = Object.fromEntries(purchases.map((purchase) => [
    purchase.investmentId ?? purchase.symbol,
    calculateInvestmentReturn(purchase, now),
  ]))
  const cooldowns = Object.fromEntries(purchases.map((purchase) => [purchase.symbol, purchase.expiresAt ?? 0]))
  const transactions: AccountTransaction[] = (transactionsResult.data ?? [])
    .filter((transaction) => ['bid', 'deposit', 'investment', 'swap'].includes(transaction.category))
    .map((transaction) => ({
      id: transaction.id,
      category: transaction.category as AccountTransaction['category'],
      description: transaction.description,
      amount: Number(transaction.amount),
      timestamp: new Date(transaction.created_at).getTime(),
    }))
  transactions.push(...(paymentRequestsResult.data ?? []).map((request) => ({
    id: request.id,
    category: 'withdraw' as const,
    description: `Withdrawal to ${request.phone_number}`,
    amount: Number(request.amount),
    timestamp: new Date(request.created_at).getTime(),
    status: request.status,
  })))
  transactions.sort((left, right) => right.timestamp - left.timestamp)
  const loans: LoanApplication[] = (loansResult.data ?? []).map((loan) => ({
    id: loan.id,
    amount: Number(loan.amount),
    durationMonths: loan.duration_months,
    timestamp: new Date(loan.created_at).getTime(),
    status: loan.status === 'approved' ? 'Approved' : loan.status === 'rejected' ? 'Rejected' : 'Pending',
  }))
  const rewards: RewardRecord[] = (rewardsResult.data ?? []).map((reward) => ({
    id: reward.id,
    type: reward.reward_type,
    title: reward.title,
    detail: reward.detail,
    timestamp: new Date(reward.created_at).getTime(),
  }))

  return {
    profile: {
      ...displayDetails,
      referralCode: profile.referral_code,
      ...(profile.referred_by ? { referredBy: profile.referred_by } : {}),
    },
    purchases,
    performance,
    cooldowns,
    transactions,
    loans,
    rewards,
    firstInvestmentOfferUsed: profile.first_investment_discount_used,
    investmentReturnsEnabled,
  }
}

export async function loadBackendWalletBalance(userId: string): Promise<number> {
  const { data, error } = await requireSupabase()
    .from('wallets')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw queryError('Could not load wallet balance', error)
  if (!data || !Number.isFinite(Number(data.balance))) {
    throw new Error('The wallet row is missing or has an invalid balance. Apply the Supabase migrations and verify the account profile/wallet records.')
  }
  return Number(data.balance)
}

export async function loadBackendAuctions(): Promise<{ auctions: Auction[]; progress: Record<string, AuctionProgress> }> {
  const client = requireSupabase()
  const auctionsRequest = client.from('auctions').select('id, title, image_url, starting_bid, bid_target, prize_value').eq('active', true).order('title')
  const [auctionsResult, statusesResult] = await Promise.all([
    auctionsRequest,
    retryNetworkRead(
      () => client.rpc('get_auction_statuses'),
      (result) => isNetworkFetchFailure(result.error),
    ),
  ])
  if (auctionsResult.error) throw queryError('Could not load auctions', auctionsResult.error)
  if (statusesResult.error) throw queryError('Could not load auction status', statusesResult.error)

  const auctions: Auction[] = (auctionsResult.data ?? []).map((auction) => ({
    id: auction.id,
    title: auction.title,
    image: auction.image_url,
    bidder: 'Bidding',
    bid: Number(auction.starting_bid),
    bidTarget: auction.bid_target,
    ...(auction.prize_value === null ? {} : { itemValue: Number(auction.prize_value) }),
  }))
  const progress: Record<string, AuctionProgress> = {}
  for (const status of statusesResult.data ?? []) {
    const entryCount = Number(status.entry_count)
    progress[status.auction_id] = {
      entries: Array.from({ length: entryCount }, (_, index) => ({
        bidder: 'Participant',
        amount: index === entryCount - 1 ? Number(status.last_amount ?? 0) : 0,
      })),
      winner: status.last_winner,
      round: status.round_number,
      entryCount,
      totalAmount: Number(status.total_amount),
      lastAmount: Number(status.last_amount ?? 0),
      nextAmount: Number(status.next_amount),
      ...(status.last_won_at ? { completedAt: new Date(status.last_won_at).getTime() } : {}),
    }
  }
  return { auctions, progress }
}

export async function buyDemoInvestment(symbol: string, company: string, shares: number, unitPrice: number) {
  const { data, error } = await requireSupabase().rpc('buy_demo_investment', {
    p_symbol: symbol,
    p_company: company,
    p_shares: shares,
    p_unit_price: unitPrice,
  })
  return parseInvestmentRpcResult(data, error)
}

export async function swapBackendInvestmentReturns() {
  const { data, error } = await requireSupabase().rpc('swap_investment_returns')
  return parseInvestmentReturnSwapResult(data, error)
}

export async function placeBackendBid(auctionId: string) {
  const { data, error } = await requireSupabase().rpc('place_auction_bid', { p_auction_id: auctionId })
  return parseAuctionBidRpcResult(data, error)
}

export async function submitBackendLoan(amount: number, durationMonths: number) {
  const { data, error } = await requireSupabase().rpc('submit_loan_application', {
    p_amount: amount,
    p_duration_months: durationMonths,
  })
  if (error) throw error
  return data as string
}

export async function submitBackendWithdrawal(amount: number, phoneNumber: string): Promise<string> {
  const { data, error } = await requireSupabase().rpc('submit_payment_request', {
    p_request_type: 'withdraw',
    p_amount: amount,
    p_phone_number: phoneNumber,
  })
  if (error) throw queryError('Could not submit withdrawal request', error)
  if (typeof data !== 'string') throw new Error('The withdrawal request returned an invalid ID.')
  return data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function invokeSupabaseFunction(
  functionName: string,
  body: Record<string, string | number>,
  label: string,
): Promise<unknown> {
  const client = requireSupabase()
  if (!supabaseUrl) throw new Error('Supabase URL is not configured.')
  if (!supabaseAnonKey) throw new Error('Supabase publishable key is not configured.')
  const { data, error } = await client.auth.getSession()
  if (error) throw new Error(`Could not read the signed-in session: ${error.message}`)
  if (!data.session?.access_token) throw new Error('Sign in again before making a payment.')

  const functionUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/${functionName}`
  let response: Response
  try {
    response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    const cause = error instanceof Error ? ` ${error.message}` : ''
    throw new Error(`Could not reach ${functionUrl}.${cause} Check the function's CORS settings and network connection.`, { cause })
  }

  const text = await response.text()
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 300)}`)
    throw new Error(`${label} returned an invalid response.`)
  }
  if (!response.ok) {
    const message = isRecord(result) && typeof (result.error ?? result.message) === 'string'
      ? String(result.error ?? result.message)
      : `${label} returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return result
}

async function invokePaystackDeposits(body: Record<string, string>): Promise<unknown> {
  return invokeSupabaseFunction('paystack-deposits', body, 'Deposit function')
}

export type BackendDepositCheckout = { checkoutUrl: string }
export type BackendDepositVerification = { status: 'success' | 'pending' }
export type BackendMpesaDeposit = { reference: string; message: string }
export type BackendMpesaDepositVerification = { status: 'success' | 'pending' | 'failed'; message?: string }

export async function requestBackendMpesaDeposit(amount: number): Promise<BackendMpesaDeposit> {
  const data = await invokeSupabaseFunction('paystack-mpesa-deposit', { action: 'charge', amount }, 'M-Pesa deposit function')
  if (!isRecord(data) || typeof data.reference !== 'string' || typeof data.message !== 'string') {
    throw new Error('The M-Pesa deposit function returned an invalid payment request.')
  }
  return { reference: data.reference, message: data.message }
}

export async function verifyBackendMpesaDeposit(reference: string): Promise<BackendMpesaDepositVerification> {
  const data = await invokeSupabaseFunction('paystack-mpesa-deposit', { action: 'verify', reference }, 'M-Pesa deposit function')
  if (!isRecord(data)) {
    throw new Error('The M-Pesa deposit function returned an invalid payment status.')
  }
  const status = data.status
  if (status !== 'success' && status !== 'pending' && status !== 'failed') {
    throw new Error('The M-Pesa deposit function returned an invalid payment status.')
  }
  return {
    status,
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
  }
}

export async function initializeBackendDeposit(amount: number): Promise<BackendDepositCheckout> {
  const data = await invokePaystackDeposits({ action: 'initialize', amount: amount.toFixed(2) })
  if (!isRecord(data)) throw new Error('Paystack returned an unexpected checkout response.')

  const checkoutData = isRecord(data.data) ? data.data : data
  const checkoutUrlValue = checkoutData.checkoutUrl
    ?? checkoutData.checkout_url
    ?? checkoutData.authorization_url
    ?? checkoutData.url
  if (typeof checkoutUrlValue !== 'string') throw new Error('Paystack did not return a checkout URL.')
  let checkoutUrl: URL
  try {
    checkoutUrl = new URL(checkoutUrlValue)
  } catch {
    throw new Error('Paystack returned an invalid checkout URL.')
  }
  if (checkoutUrl.protocol !== 'https:') throw new Error('Paystack returned an insecure checkout URL.')
  return { checkoutUrl: checkoutUrl.toString() }
}

export async function verifyBackendDeposit(reference: string): Promise<BackendDepositVerification> {
  const data = await invokePaystackDeposits({ action: 'verify', reference })
  if (!isRecord(data)) throw new Error('Paystack returned an unexpected verification response.')

  const result = isRecord(data.data) ? data.data : data
  if (result.success === true || result.verified === true || result.status === 'success' || result.status === 'succeeded') {
    return { status: 'success' }
  }
  if (result.status === 'pending' || result.status === 'processing') return { status: 'pending' }
  throw new Error(typeof result.message === 'string'
    ? result.message
    : typeof result.error === 'string' ? result.error : 'Paystack could not verify this deposit.')
}
