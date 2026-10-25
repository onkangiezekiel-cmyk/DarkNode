create or replace function public.guard_mpesa_withdrawal_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.transaction_type = 'deposit' then
    perform 1
    from public.profiles p
    where p.user_id = new.user_id
    for update;
    if not found then
      raise exception 'Account profile was not found.';
    end if;

    if exists (
      select 1 from public.mpesa_transactions t
      where t.user_id = new.user_id
        and t.transaction_type = 'deposit'
        and t.status in ('initiating', 'pending', 'reconciliation')
    ) then
      raise exception 'A previous deposit is unresolved. Check its status before requesting another.';
    end if;
    return new;
  end if;

  if new.transaction_type <> 'withdrawal' then
    return new;
  end if;

  perform 1
  from public.profiles p
  where p.user_id = new.user_id and p.account_status = 'active'
  for update;
  if not found then
    raise exception 'Account is not eligible for withdrawals.';
  end if;

  if exists (
    select 1 from public.mpesa_transactions t
    where t.user_id = new.user_id
      and t.transaction_type = 'withdrawal'
      and t.status in ('reserved', 'submitted', 'reconciliation')
  ) then
    raise exception 'A previous withdrawal is unresolved. Check its status or contact support before requesting another.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_mpesa_withdrawal_insert() from public, anon, authenticated;

create or replace function public.record_mpesa_withdrawal_submission(
  p_transaction_id uuid,
  p_status text,
  p_originator_conversation_id text,
  p_conversation_id text,
  p_result_code text,
  p_result_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transaction public.mpesa_transactions%rowtype;
  v_replace_placeholder boolean;
begin
  if p_status not in ('submitted', 'reconciliation') then
    raise exception 'Invalid payout status.';
  end if;

  select * into v_transaction
  from public.mpesa_transactions t
  where t.id = p_transaction_id and t.transaction_type = 'withdrawal'
  for update;
  if not found then raise exception 'Withdrawal was not found.'; end if;

  if v_transaction.status in ('succeeded', 'failed') then
    return;
  end if;
  if v_transaction.status not in ('reserved', 'submitted', 'reconciliation') then
    raise exception 'Withdrawal is not awaiting provider submission.';
  end if;

  v_replace_placeholder :=
    v_transaction.originator_conversation_id = v_transaction.id::text
    and (
      p_conversation_id is null
      or v_transaction.conversation_id is null
      or v_transaction.conversation_id = p_conversation_id
    )
    and nullif(p_originator_conversation_id, '') is not null;

  if v_transaction.originator_conversation_id is not null
    and p_originator_conversation_id is not null
    and v_transaction.originator_conversation_id <> p_originator_conversation_id
    and not v_replace_placeholder then
    raise exception 'Payout originator identifier does not match.';
  end if;
  if v_transaction.conversation_id is not null
    and p_conversation_id is not null
    and v_transaction.conversation_id <> p_conversation_id then
    raise exception 'Payout conversation identifier does not match.';
  end if;

  update public.mpesa_transactions
  set status = case
        when v_transaction.status = 'reconciliation' then 'reconciliation'
        else p_status
      end,
      originator_conversation_id = case
        when v_replace_placeholder then nullif(p_originator_conversation_id, '')
        else coalesce(originator_conversation_id, nullif(p_originator_conversation_id, ''))
      end,
      conversation_id = coalesce(conversation_id, nullif(p_conversation_id, '')),
      provider_result_code = coalesce(nullif(p_result_code, ''), provider_result_code),
      provider_result_description = left(coalesce(p_result_description, provider_result_description, ''), 240)
  where id = p_transaction_id;
end;
$$;

revoke all on function public.record_mpesa_withdrawal_submission(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_mpesa_withdrawal_submission(uuid, text, text, text, text, text) to service_role;
