-- GitHub-only sign-in (#1450). The stable Board identity becomes the GitHub
-- user id; the Google subject and email are retired as sign-in identities.

-- 1. Remap dependent tables while GithubCredential still holds the Google
--    identity, matching on the Google subject (boardSub) or the address.
UPDATE "PersonalToken" t
SET "ownerSub" = c."githubUserId",
    "ownerEmail" = c."githubLogin"
FROM "GithubCredential" c
WHERE lower(t."ownerEmail") = lower(c."ownerEmail")
   OR t."ownerSub" = c."boardSub";

UPDATE "McpGrant" g
SET "sub" = c."githubUserId",
    "email" = c."githubLogin"
FROM "GithubCredential" c
WHERE g."sub" = c."boardSub";

UPDATE "PersonalGoal" p
SET "sub" = c."githubUserId"
FROM "GithubCredential" c
WHERE p."sub" = c."boardSub";

UPDATE "SessionEpoch" e
SET "sub" = c."githubUserId"
FROM "GithubCredential" c
WHERE e."sub" = c."boardSub";

-- 2. Repoint the credential's own identity columns. The login is what the
--    session carries as its address, so it becomes the primary key value.
UPDATE "GithubCredential" SET "boardSub" = "githubUserId";
UPDATE "GithubCredential" SET "ownerEmail" = lower("githubLogin");
