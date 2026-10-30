-- Single-use marker for a Github SIGN-IN seal (#892 review, C1). A sign-in
-- flow captures no credential version, so the connect compare-and-swap has
-- nothing to match on; the issue time of the newest admitted seal is recorded
-- here instead, and only once admission has been established. A seal older
-- than the mark is refused, so replaying one after a later flow has completed
-- is refused too.
ALTER TABLE "GithubCredential" ADD COLUMN "signInAdmittedAt" TIMESTAMP(3);
