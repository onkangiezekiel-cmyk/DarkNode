import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

if (Boolean(supabaseUrl) !== Boolean(supabaseAnonKey)) {
  throw new Error('Configure both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
if (import.meta.env.PROD && !isSupabaseConfigured) {
  throw new Error('Supabase is required for production builds. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  })
  : null
