# Supabase setup

The app uses Supabase Auth and Postgres for account profiles, wallet balances, investments, auctions, referrals, loan requests, and withdrawal requests. New deposits use the `paystack-mpesa-deposit` Edge Function to send an M-Pesa payment prompt to the registered Kenyan number without redirecting away from the account page. The existing `paystack-deposits` function remains available for checkout-based references. Withdrawals are requests for manual payment; no automatic payout provider is connected.

## Configure a project

1. Create a Supabase project and enable email/password sign-in under **Authentication → Providers**.
2. Copy the project URL and publishable key (or legacy anon key) from **Project Settings → API**.
3. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` using the project URL and public anon/publishable key from **Project Settings → API**. For the deployed deposit function in this setup, `VITE_SUPABASE_URL` must be `https://xoheekwyjromtsizxwpl.supabase.co`. Never use a `service_role` or secret key in this frontend.
4. In Vercel, open the project connected to this repository and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under **Settings → Environment Variables** for every environment you deploy (Production, and Preview if needed). Use the same values as `.env.local`, then redeploy so Vite includes them in the client build. Do not commit `.env.local` or put a service-role/secret key in any `VITE_*` variable.
5. Run the SQL migrations present in `supabase/migrations/` in timestamp order, including `202611160002_paystack_mpesa_wallet_credit.sql`.
6. In **Authentication → URL Configuration**, set the local and deployed site URLs and add the app's sign-in redirect URLs.
7. Configure email confirmation and SMTP before production use.
8. Set `PAYSTACK_SECRET_KEY` as a Supabase Edge Function secret. Use a test key while testing; use a live key only for your live Paystack business account:

	```sh
	supabase secrets set PAYSTACK_SECRET_KEY=sk_test_your_key
	```

9. Deploy the in-page M-Pesa function after applying the wallet-credit migration:

	```sh
	supabase functions deploy paystack-mpesa-deposit
	```

	The function accepts the signed-in user's JWT, reads the registered phone number from the profile, and starts a Paystack M-Pesa charge. The user must approve the prompt on their phone. The account page stays open and checks the transaction status; a successful, verified payment credits the wallet and transaction history once per Paystack reference. Ensure M-Pesa is enabled for the correct Paystack test or live account.

	The existing `paystack-deposits` function accepts `initialize` and `verify` actions for checkout-based payment references. It is not used to start new deposits from the account page.

Checkout-based deposits are verified when Paystack returns the user to the app's `/account` route with the `reference` query parameter (Paystack may also return `trxref`). New in-page M-Pesa deposits do not use that redirect; they are verified while the account page remains open.

Withdrawal requests are stored in `public.payment_requests` with `request_type = 'withdraw'`. Apply migrations `202611050002` through `202611050008`, then `202611160001`, in timestamp order after the existing migrations. Migration `202611050007` debits any older pending requests that were created before immediate debit was enabled; it stops and rolls back if a request cannot be reserved from the wallet balance. The `submit_payment_request` RPC debits the wallet atomically when a new withdrawal request is submitted. The `payment_requests` table is read-only to regular users; only profiles with `is_admin = true` may update request status. Status values are stored lowercase; migration `202611050008` normalizes case when admins edit them. In the Supabase SQL Editor, set that flag for your administrator profile after confirming the user's ID in Authentication → Users:

```sql
update public.profiles
set is_admin = true
where user_id = 'YOUR_AUTH_USER_UUID';
```

Then pay the requested M-Pesa number or adjust the wallet balance manually and set the request status to `success` when paid. Changing status never refunds the withdrawal automatically. Requests that do not have enough wallet balance cannot be created.

When Supabase environment variables are absent, the app stays in isolated browser-demo mode. Demo data is never uploaded or migrated.

## Security boundaries

- Auth passwords are handled only by Supabase Auth.
- The frontend uses only the Supabase project URL and publishable/anon key. Never expose a service-role key in browser code or a `VITE_*` variable.
- Paystack checkout initialization and verification are performed by the deployed `paystack-deposits` Edge Function. Its secret key stays server-side; the client only sends the signed-in user's JWT and deposit amount.
- Withdrawal requests are owner-readable under RLS and created through the existing `submit_payment_request` RPC, which debits the available balance in the same transaction. Status changes do not automatically refund funds.
- Row-level security scopes profile and account records to their owner.
- `buy_demo_investment`, `place_auction_bid`, and `swap_investment_returns` perform simulated account changes inside database transactions.
- Investment catalog values and returns are simulations, not brokerage orders, live prices, financial advice, or guaranteed returns.
- Loan submissions are requests marked pending; no lending or credit decision is automated.

Portfolio, auction, and investment activity remain simulated. Review the database policies and migrations against a non-production project before deployment.
