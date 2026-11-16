create table public.paystack_mpesa_deposits (
  reference text primary key check (char_length(reference) between 1 and 100),
  user_id uuid not null references public.profiles(user_id),
  amount numeric(14, 2) not null check (amount > 0),
  credited_at timestamptz not null default now()
);

alter table public.paystack_mpesa_deposits enable row level security;

create or replace function public.credit_paystack_mpesa_deposit(
  p_user_id uuid,
  p_reference text,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount numeric(14, 2);
  v_existing_user_id uuid;
  v_existing_amount numeric(14, 2);
begin
  if p_user_id is null or p_reference is null
    or char_length(p_reference) not between 1 and 100
    or p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Invalid Paystack M-Pesa deposit.';
  end if;

  v_amount := round(p_amount, 2);
  if v_amount <= 0 then raise exception 'Deposit amount must be at least KSh 0.01.'; end if;

  insert into public.paystack_mpesa_deposits (reference, user_id, amount)
    values (p_reference, p_user_id, v_amount)
    on conflict (reference) do nothing;

  if not found then
    select user_id, amount
      into v_existing_user_id, v_existing_amount
      from public.paystack_mpesa_deposits
      where reference = p_reference;
    if v_existing_user_id <> p_user_id or v_existing_amount <> v_amount then
      raise exception 'Paystack reference was already credited to a different deposit.';
    end if;
    return;
  end if;

  update public.wallets
    set balance = balance + v_amount, updated_at = now()
    where user_id = p_user_id;
  if not found then raise exception 'Wallet not found for Paystack M-Pesa deposit.'; end if;

  insert into public.wallet_transactions (user_id, category, description, amount)
    values (p_user_id, 'deposit', 'M-Pesa deposit via Paystack', v_amount);
end;
$$;

revoke all on function public.credit_paystack_mpesa_deposit(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.credit_paystack_mpesa_deposit(uuid, text, numeric) to service_role;
