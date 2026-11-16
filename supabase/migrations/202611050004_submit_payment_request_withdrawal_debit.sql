create or replace function public.submit_payment_request(
  p_request_type text,
  p_amount numeric,
  p_phone_number text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_request_id uuid;
  v_amount numeric(14, 2);
begin
  if v_user_id is null then raise exception 'Sign in is required.'; end if;
  if p_request_type not in ('deposit', 'withdraw') or p_amount is null
    or p_amount <= 0 or p_amount > 10000000 or p_phone_number is null
    or char_length(trim(p_phone_number)) not between 3 and 32 then
    raise exception 'Invalid payment request.';
  end if;

  v_amount := round(p_amount, 2);
  if v_amount <= 0 then raise exception 'Amount must be at least KSh 0.01.'; end if;

  if p_request_type = 'withdraw' then
    update public.wallets
      set balance = balance - v_amount, updated_at = now()
      where user_id = v_user_id and balance >= v_amount;
    if not found then raise exception 'Insufficient wallet balance.'; end if;
  end if;

  insert into public.payment_requests (user_id, request_type, amount, phone_number, debited_at)
    values (
      v_user_id,
      p_request_type,
      v_amount,
      trim(p_phone_number),
      case when p_request_type = 'withdraw' then now() else null end
    )
    returning id into v_request_id;

  if p_request_type = 'withdraw' then
    insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
      values (v_user_id, 'withdraw', 'Withdrawal request to ' || trim(p_phone_number), -v_amount, v_request_id);
  end if;

  return v_request_id;
end;
$$;
revoke all on function public.submit_payment_request(text, numeric, text) from public, anon;
grant execute on function public.submit_payment_request(text, numeric, text) to authenticated;

drop function if exists public.request_withdrawal(numeric, text);