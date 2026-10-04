-- Run after schema.sql. Safe to run again.

-- Make sure the signed-in role can use the tables (RLS still limits rows).
grant select, insert, update, delete on public.devices, public.ops, public.receipts to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- "Device p_device has applied these ops." Leaves a receipt for each op's
-- author, drops the device from pending_for, deletes ops nobody is waiting
-- for any more, and returns the ids of those fully delivered ops so the
-- caller can delete their media from storage.
create or replace function public.ack_ops(p_ids uuid[], p_device uuid)
returns uuid[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  done uuid[];
begin
  insert into public.receipts (to_device, op_id)
    select device, id from public.ops
    where id = any(p_ids) and user_id = auth.uid() and p_device = any(pending_for);

  update public.ops
    set pending_for = array_remove(pending_for, p_device)
    where id = any(p_ids) and user_id = auth.uid();

  with gone as (
    delete from public.ops
    where id = any(p_ids) and user_id = auth.uid() and pending_for = '{}'
    returning id
  )
  select coalesce(array_agg(id), '{}') into done from gone;

  return done;
end;
$$;

grant execute on function public.ack_ops(uuid[], uuid) to authenticated;
