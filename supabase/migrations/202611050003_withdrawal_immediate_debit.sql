alter table public.payment_requests
  add column if not exists debited_at timestamptz,
  add column if not exists refunded_at timestamptz;

drop trigger if exists payment_requests_settle_successful_withdrawal on public.payment_requests;
drop function if exists public.settle_successful_withdrawal();

update public.payment_requests
  set debited_at = coalesce(reviewed_at, created_at)
  where request_type = 'withdraw' and status = 'success' and debited_at is null;

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
  v_request_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in is required.'; end if;
  if p_request_type is distinct from 'deposit' or p_amount is null
    or p_amount <= 0 or p_amount > 10000000 or p_phone_number is null
    or char_length(trim(p_phone_number)) not between 3 and 32 then
    raise exception 'Invalid payment request. Use the withdrawal request action for withdrawals.';
  end if;
  insert into public.payment_requests (user_id, request_type, amount, phone_number)
    values (auth.uid(), 'deposit', round(p_amount, 2), trim(p_phone_number))
    returning id into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function public.submit_payment_request(text, numeric, text) from public, anon;
grant execute on function public.submit_payment_request(text, numeric, text) to authenticated;

create or replace function public.request_withdrawal(
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
  v_amount numeric(14, 2);
  v_request_id uuid;
begin
  if v_user_id is null then raise exception 'Sign in is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000
    or p_phone_number is null or char_length(trim(p_phone_number)) not between 3 and 32 then
    raise exception 'Invalid withdrawal request.';
  end if;
  v_amount := round(p_amount, 2);
  if v_amount <= 0 then raise exception 'Withdrawal amount must be at least KSh 0.01.'; end if;

  update public.wallets
    set balance = balance - v_amount, updated_at = now()
    where user_id = v_user_id and balance >= v_amount;
  if not found then raise exception 'Insufficient wallet balance.'; end if;

  insert into public.payment_requests (user_id, request_type, amount, phone_number, debited_at)
    values (v_user_id, 'withdraw', v_amount, trim(p_phone_number), now())
    returning id into v_request_id;

  insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
    values (v_user_id, 'withdraw', 'Withdrawal request to ' || trim(p_phone_number), -v_amount, v_request_id);

  return v_request_id;
end;
$$;
revoke all on function public.request_withdrawal(numeric, text) from public, anon;
grant execute on function public.request_withdrawal(numeric, text) to authenticated;

create or replace function public.handle_withdrawal_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.request_type <> 'withdraw' or old.status = new.status then
    return new;
  end if;

  if old.status in ('success', 'rejected') then
    raise exception 'A completed withdrawal status cannot be changed.';
  end if;

  if new.status = 'success' and new.debited_at is null then
    update public.wallets
      set balance = balance - new.amount, updated_at = now()
      where user_id = new.user_id and balance >= new.amount;
    if not found then raise exception 'Insufficient wallet balance to complete this legacy withdrawal.'; end if;
    insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
      values (new.user_id, 'withdraw', 'Withdrawal paid to ' || new.phone_number, -new.amount, new.id);
    new.debited_at := now();
  elsif new.status = 'rejected' and old.debited_at is not null and old.refunded_at is null then
    update public.wallets
      set balance = balance + new.amount, updated_at = now()
      where user_id = new.user_id;
    if not found then raise exception 'Could not refund rejected withdrawal.'; end if;
    insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
      values (new.user_id, 'deposit', 'Refund for rejected withdrawal', new.amount, new.id);
    new.refunded_at := now();
  end if;

  if new.status in ('success', 'rejected') then
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;
revoke all on function public.handle_withdrawal_status_change() from public, anon, authenticated;

create trigger payment_requests_handle_withdrawal_status
  before update of status on public.payment_requests
  for each row
  when (new.request_type = 'withdraw')
  execute function public.handle_withdrawal_status_change();