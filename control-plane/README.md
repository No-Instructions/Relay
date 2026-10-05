# Relay control plane

Replaces relay.md's API for this fork: Authentik login, collections, and
tokens for an upstream relay-server.

```
 Obsidian + plugin --PocketBase SDK, /token, /file-token--> control plane --OIDC--> Authentik
                   --wss /d/*, https /f/*----------------> relay-server (verifies with public key)
```

| path | what |
|---|---|
| `pb_migrations/1760000000_schema.js` | collections, rules, fixed role rows |
| `pb_hooks/00_config.pb.js` | OIDC provider `oidc` and the `providers` row from env, on every start |
| `pb_hooks/10_relays.pb.js` | relay defaults, owner role, invitation, `/api/accept-invitation`, `/api/rotate-key` |
| `pb_hooks/20_tokens.pb.js` | `/token`, `/file-token` |
| `pb_hooks/30_misc.pb.js` | `/health`, `/whoami`, `/flags`, `/relay/{guid}/check-host` |
| `pb_hooks/relay.js` | shared helpers (handlers cannot see file-level names) |
| `y-sign.patch` | applied to relay-server 0.12.7 `y-sign` at image build |
| `Dockerfile` | PocketBase 0.40.4 + hooks + patched `y-sign`, runs as uid 10001 |
| `compose.yaml` | local run with relay-server |

## Environment

| var | value |
|---|---|
| `RELAY_SERVER_URL` | `https://relay.infra.sentrisense.network`; also the token audience |
| `RELAY_SERVER_AUTH` | Ed25519 private key from `gen-auth` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Authentik provider `relay` (infra `243-relay-oidc.tf`) |
| `OIDC_ISSUER` | `https://auth.sentrisense.network/application/o/` |

## Tokens: what relay-server needs

- Doc ids on relay-server are `<relayGuid>-<docGuid>` (its `subdocs.rs` assumes
  this layout). The plugin sends guids; the hook builds the id.
- A doc in a folder gets `channel = <relayGuid>-<folderGuid>`, so its updates
  reach the folder connection as `document.updated` events (background sync).
- `expiryTime` is in every response; the plugin treats a token without it as expired.

Stock `y-sign sign` adds no audience claim, which relay-server rejects
("CWT token missing audience claim"), and cannot set `user` or `channel`.
`y-sign.patch` fixes both. Still true on upstream main as of 2026-10-05.

## Keys (once)

```sh
docker run --rm --entrypoint ./relay docker.system3.md/relay-server:0.12.7 gen-auth --json --key-type EdDSA
```

Store `private_key` as `relay_server_auth` and `public_key` as
`relay_server_public_key` in the 20-gke-primary sops secrets. `key_id` and
`server_token` are unused.

## Local run

Needs the dev redirect `http://127.0.0.1:8090/api/oauth2-redirect` in Authentik
(in `243-relay-oidc.tf` during the pilot).

```sh
cd control-plane
cat > relay.local.toml <<EOF
[server]
url = "http://127.0.0.1:8080"
host = "0.0.0.0"
port = 8080

[[auth]]
public_key = "<public_key>"

[store]
type = "filesystem"
path = "/app/data"
EOF
RELAY_SERVER_AUTH=<private_key> OIDC_CLIENT_SECRET=<secret> docker compose up --build
```

Plugin against it: `RELAY_API_URL=http://127.0.0.1:8090 npm run dev`, then copy
`main.js`, `styles.css`, `manifest.json` to `<vault>/.obsidian/plugins/system3-relay/`.

## Operating

- Dashboard superuser: `kubectl -n relay exec deploy/relay-control-plane -- /app/pocketbase superuser upsert --dir=/data/pb_data <email> <password>`.
- The role menu offers Reader only once some role record uses it. Set the
  first Reader in the dashboard (`relay_roles.role` = `readerrole00001`).
- Schema changes go in a new file under `pb_migrations/`; the image runs with
  `--automigrate=false`, so dashboard schema edits are not saved as migrations.
