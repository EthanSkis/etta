-- Family magic-link view: each senior gets a long random share token. The
-- summary text links to /functions/v1/fam/<token>; possession of the token
-- IS the authentication (no app, no login). Rotate by regenerating:
--   update seniors set share_token = encode(extensions.gen_random_bytes(12), 'hex')
--   where id = '...';

create extension if not exists pgcrypto with schema extensions;

alter table public.seniors
  add column share_token text not null unique
  default encode(extensions.gen_random_bytes(12), 'hex');

comment on column public.seniors.share_token is
  'Capability token for the no-login family web view. Anyone holding it can read this senior''s summaries — long, random, rotatable.';
