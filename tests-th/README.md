Tests contributed from outside the git-crypt key. `__tests__/**` is encrypted, so a
contributor without the key can neither read its conventions nor add a reviewable file
there; these live in plaintext instead. Jest's default testMatch picks them up
(`npx jest tests-th`).

Maintainers are welcome to move these under `__tests__/` and delete this directory.
