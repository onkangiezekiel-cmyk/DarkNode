do $$
declare
  v_request record;
begin
  for v_request in
    select id, user_id, amount, phone_number
      from public.payment_requests
      where request_type = 'withdraw'
        and status in ('pending', 'approved')
        and debited_at is null
      order by created_at, id
      for update
  loop
    if exists (
      select 1
        from public.wallet_transactions
        where reference_id = v_request.id and category = 'withdraw'
    ) then
      update public.payment_requests
        set debited_at = now()
        where id = v_request.id;
      continue;
    end if;

    update public.wallets
      set balance = balance - v_request.amount, updated_at = now()
      where user_id = v_request.user_id and balance >= v_request.amount;
    if not found then
      raise exception 'Cannot reserve existing withdrawal %: wallet balance is insufficient.', v_request.id;
    end if;

    insert into public.wallet_transactions (user_id, category, description, amount, reference_id)
      values (
        v_request.user_id,
        'withdraw',
        'Withdrawal request to ' || v_request.phone_number,
        -v_request.amount,
        v_request.id
      );

    update public.payment_requests
      set debited_at = now()
      where id = v_request.id;
  end loop;
end;
$$;