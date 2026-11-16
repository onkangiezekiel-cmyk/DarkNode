alter table public.profiles
  add column if not exists is_admin boolean not null default false;

grant update (status, reviewed_at, review_note) on public.payment_requests to authenticated;
grant update (status, reviewed_at, review_note) on public.payment_requests to service_role;

create policy "Admins update payment request status"
  on public.payment_requests for update to authenticated
  using (
    exists (
      select 1
      from public.profiles
      where user_id = (select auth.uid()) and is_admin
    )
  )
  with check (
    exists (
      select 1
      from public.profiles
      where user_id = (select auth.uid()) and is_admin
    )
  );