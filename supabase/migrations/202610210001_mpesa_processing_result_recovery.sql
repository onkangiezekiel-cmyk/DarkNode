update public.mpesa_transactions
set status = 'pending',
    completed_at = null,
    updated_at = now()
where transaction_type = 'deposit'
  and status = 'failed'
  and provider_result_code = '4999'
  and provider_result_description = 'The transaction is still under processing'
  and mpesa_receipt_number is null;
