import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { LockKeyhole } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { normalizeKenyanPhone } from '../lib/kenyanPhone'

type AuthPageProps = {
  mode: 'signin' | 'signup'
  onSignup?: (profile: { fullName: string; phoneNumber: string; referredBy?: string }) => void
}

function getAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/email rate limit exceeded|rate limit.*email/i.test(message)) {
    return 'Too many account requests were made. Please wait a while before trying again.'
  }
  return 'Account access failed. Check your details and try again.'
}

export default function AuthPage({ mode, onSignup }: AuthPageProps) {
  const isSignUp = mode === 'signup'
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [phoneDigits, setPhoneDigits] = useState('')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const referralCode = searchParams.get('ref')?.trim().toUpperCase() ?? ''

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    if (isSignUp && password !== form.get('confirmPassword')) {
      setMessage('Your passwords do not match. Please check and try again.')
      return
    }
    let normalizedPhone = ''
    if (isSignUp) {
      if (!/^\d{9}$/.test(phoneDigits)) {
        setMessage('Enter exactly 9 digits after +254.')
        return
      }
      try {
        normalizedPhone = `+${normalizeKenyanPhone(`+254${phoneDigits}`)}`
      } catch (error) {
        console.error('Account access request failed.', error)
        setMessage(getAuthErrorMessage(error))
        return
      }
    }
    setSubmitting(true)
    setMessage('')
    try {
      if (supabase) {
        const email = String(form.get('email') ?? '').trim()
        if (isSignUp) {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                full_name: String(form.get('fullName') ?? '').trim(),
                phone_number: normalizedPhone,
                ...(referralCode ? { referral_code: referralCode } : {}),
              },
              emailRedirectTo: `${window.location.origin}/home`,
            },
          })
          if (error) throw error
          if (data.session) navigate('/home')
          else setMessage('Account created. Check your email to confirm your address, then sign in.')
          return
        }

        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        navigate('/home')
        return
      }

      if (isSignUp && onSignup) {
        onSignup({
          fullName: String(form.get('fullName') ?? '').trim(),
          phoneNumber: normalizedPhone,
          ...(referralCode ? { referredBy: referralCode } : {}),
        })
        navigate('/home')
        return
      }
      setMessage('Sign in is not available in browser demo mode. Configure Supabase to enable authentication.')
    } catch (error) {
      setMessage(getAuthErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span className="brand-mark">DN</span>
          <span><strong>DarkNode</strong><small>smart money</small></span>
        </div>
        <div className="auth-intro">
          <span className="auth-eyebrow"><LockKeyhole size={14} /> ACCOUNT ACCESS</span>
          <h1 id="auth-title">{isSignUp ? 'Create your account' : 'Welcome back'}</h1>
          <p>{isSignUp ? 'Get started with your DarkNode account.' : 'Sign in to continue to your account.'}</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isSignUp && (
            <>
              <label className="field-label" htmlFor="full-name">Full names</label>
              <input className="form-input" id="full-name" name="fullName" type="text" autoComplete="name" placeholder="Your full name" minLength={2} required />
              {referralCode && (
                <>
                  <label className="field-label" htmlFor="signup-referral-code">Referral code</label>
                  <input className="form-input" id="signup-referral-code" name="referralCode" value={referralCode} readOnly />
                </>
              )}
            </>
          )}
          <label className="field-label" htmlFor="auth-email">Email address</label>
          <input className="form-input" id="auth-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
          {isSignUp && (
            <>
              <label className="field-label" htmlFor="auth-phone">Phone number</label>
              <div className="phone-input-row">
                <span className="phone-country-code" aria-hidden="true">+254</span>
                <input
                  className="form-input"
                  id="auth-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel-national"
                  inputMode="numeric"
                  pattern="[0-9]{9}"
                  minLength={9}
                  maxLength={9}
                  value={phoneDigits}
                  onChange={(event) => setPhoneDigits(event.target.value.replace(/\D/g, '').slice(0, 9))}
                  placeholder="712345678"
                  aria-describedby="auth-phone-hint"
                  required
                />
              </div>
              <small className="phone-input-hint" id="auth-phone-hint">Enter 9 digits only.</small>
            </>
          )}
          <label className="field-label" htmlFor="auth-password">Password</label>
          <input className="form-input" id="auth-password" name="password" type="password" autoComplete={isSignUp ? 'new-password' : 'current-password'} placeholder="At least 8 characters" minLength={8} required />
          {isSignUp && (
            <>
              <label className="field-label" htmlFor="confirm-password">Confirm password</label>
              <input className="form-input" id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" placeholder="Re-enter your password" minLength={8} required />
            </>
          )}
          {message && <p className="auth-status" role="status">{message}</p>}
          <button className="primary-button full-button auth-submit" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch">
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <Link to={isSignUp ? '/signin' : '/signup'}>{isSignUp ? 'Sign in' : 'Create account'}</Link>
        </p>
      </section>
    </main>
  )
}
