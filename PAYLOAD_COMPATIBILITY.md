# Payload CMS Compatibility

This version of the Obsidian Relay client is compatible with the Payload CMS 3 control plane.

## Changes from tRPC Version

### API Endpoints

**Token Generation** (unchanged):
- `POST /api/token` - Generate document access token
- `POST /api/file-token` - Generate file access token

**Authentication**:
- Changed from `/api/oauth/login` to `/api/auth/oidc/login`
- Changed from `/api/oauth/callback` to `/api/auth/oidc/callback`

### Base API URL

- **Before**: `${controlPlaneUrl}/api/trpc`
- **After**: `${controlPlaneUrl}/api`

Token generation endpoints remain at the same paths, just without the `/trpc` prefix.

## Configuration

Set your control plane URL in the plugin settings:

```
Control Plane URL: https://your-control-plane.example.com
Relay ID: your-relay-id
```

## Authentication Flow

1. User clicks "Login" in plugin settings
2. Plugin opens browser to `/api/auth/oidc/login`
3. User authenticates via Keycloak (or other OIDC provider)
4. After successful auth, redirects to `obsidian://relay-callback`
5. Plugin receives token and stores it
6. Plugin uses token to request document/file tokens from control plane

## Token Format

Tokens remain compatible with y-sweet relay server format:
- Bincode serialization
- HMAC-SHA256 signing
- Same structure as before

## Compatibility

- ✅ Compatible with Payload CMS 3 control plane
- ✅ Compatible with y-sweet relay server
- ✅ Token format unchanged
- ✅ Document/file access unchanged

## Migration

If migrating from tRPC control plane:

1. Update plugin to this version
2. Update control plane URL in settings (if changed)
3. Re-authenticate (existing tokens will continue to work)
4. No data migration needed

## Related

- Control Plane: https://github.com/cortex-reply/obsidian-relay-control
- Relay Server: https://github.com/cortex-reply/obsidian-relay-server
