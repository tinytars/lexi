-- 0012_fix_fam4_provider_kind.sql — fam4 has never been able to spend AI budget or issue a
-- recovery grant.
--
-- functions/_lib/capabilities.ts's GRANTS table only recognises the Role literal 'primary' for
-- "ai:spend" and "recovery:issue" — every other route and every seeded test account agrees on
-- that spelling. 0002 seeded fam4 (the real "Family Provider" account) and its two provider_links
-- rows with 'clinician' instead, a value capabilities.ts has never checked. That made every
-- ai:spend/recovery:issue capability check fail for fam4 from the day it was seeded.
--
-- 0002 is left exactly as it was — it is applied history, and its INSERT is a true record of what
-- was seeded. Scoped by primary key so this can never touch an unrelated account or link that
-- happens to also carry the stale 'clinician' value.

UPDATE accounts SET provider_kind = 'primary'
 WHERE id = '12275343-91b7-431d-ae4a-15c6e092b4a6' AND provider_kind = 'clinician';

UPDATE provider_links SET role = 'primary'
 WHERE id = '1456e870-60b0-47b3-bb7a-17b59482d041' AND role = 'clinician';

UPDATE provider_links SET role = 'primary'
 WHERE id = '4dba9255-2038-4ff4-a4a0-8579a6a8a620' AND role = 'clinician';
