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
  end if;

  if new.status in ('success', 'rejected') then
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;

revoke all on function public.handle_withdrawal_status_change() from public, anon, authenticated;