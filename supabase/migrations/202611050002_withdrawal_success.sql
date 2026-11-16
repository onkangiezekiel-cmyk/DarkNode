alter table public.payment_requests
  drop constraint if exists payment_requests_status_check;

alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'success'));

create unique index if not exists wallet_transactions_withdraw_request_uidx
  on public.wallet_transactions(reference_id)
  where category = 'withdraw' and reference_id is not null;

create or replace function public.settle_successful_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.request_type <> 'withdraw'
    or new.status <> 'success'
    or old.status = 'success' then
    return new;
  end if;

  update public.wallets
    set balance = balance - new.amount, updated_at = now()
    where user_id = new.user_id and balance >= new.amount;
  if not found then
    raise exception 'Withdrawal cannot be marked successful: wallet balance is insufficient.';
  end if;

  insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
    values (
      new.user_id,
      'withdraw',
      'Withdrawal paid to ' || new.phone_number,
      -new.amount,
      new.id
    );

  return new;
end;
$$;

revoke all on function public.settle_successful_withdrawal() from public, anon, authenticated;

create trigger payment_requests_settle_successful_withdrawal
  after update of status on public.payment_requests
  for each row
  when (new.request_type = 'withdraw' and new.status = 'success' and old.status is distinct from 'success')
  execute function public.settle_successful_withdrawal();