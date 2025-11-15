# Obsidian Relay Client - Auth.js Compatible

This version of the Obsidian Relay client is updated to work with the Payload CMS 3 control plane using Auth.js (NextAuth 5) for authentication.

## Changes from Previous Version

### Authentication Flow

**Previous (Passport.js)**:
- Login: `/api/auth/oidc/login`
- Callback: `/api/auth/oidc/callback`
- Custom OAuth implementation

**Current (Auth.js)**:
- Login: `/api/auth/signin/oidc`
- Callback: Handled automatically by Auth.js at `/api/auth/callback/oidc`
- Standard Auth.js flow

### Key Improvements

1. **Automatic User Creation**: Users are automatically created in the control plane database when they first sign in
2. **Standard OAuth Flow**: Uses Auth.js standard endpoints and flow
3. **Better Session Management**: Auth.js handles session refresh and expiry automatically
4. **Simplified Code**: No custom OAuth callback handling needed

### API Endpoints

All API endpoints remain the same:
- `POST /api/token` - Generate document tokens
- `POST /api/file-token` - Generate file tokens
- `GET /api/whoami` - Get current user info
- `GET /api/flags` - Get feature flags

### Configuration

Plugin settings remain unchanged:
```
Control Plane URL: https://control.example.com
Relay ID: my-relay-id
```

## How It Works

### 1. User Clicks "Login"

Plugin opens the Auth.js sign-in URL in the system browser:
```
https://control.example.com/api/auth/signin/oidc?callbackUrl=obsidian://relay-callback
```

### 2. User Authenticates

- User is redirected to OIDC provider (Keycloak, Auth0, etc.)
- User enters credentials
- OIDC provider redirects back to Auth.js callback

### 3. Auth.js Handles Callback

- Auth.js receives the authorization code
- Exchanges code for tokens with OIDC provider
- Creates or updates user in Payload CMS database
- Sets session cookie
- Redirects to `obsidian://relay-callback`

### 4. Plugin Verifies Authentication

- Plugin receives the callback
- Calls `/api/whoami` to verify session
- Stores user info locally
- User is now authenticated

### 5. Token Generation

When accessing documents or files:
- Plugin calls `/api/token` or `/api/file-token`
- Control plane verifies Auth.js session
- Generates signed token for relay server
- Plugin uses token to connect to relay server

## Benefits

### For Users

- **Seamless Authentication**: Standard OAuth flow works with any OIDC provider
- **Automatic Account Creation**: No manual user management needed
- **Persistent Sessions**: Stay logged in across Obsidian restarts
- **Better Security**: Auth.js handles token refresh and security best practices

### For Administrators

- **Easier Setup**: Standard Auth.js configuration
- **Better Debugging**: Auth.js provides detailed logs and error messages
- **Flexible Providers**: Easy to switch between OIDC providers
- **Centralized User Management**: All users visible in Payload CMS admin panel

## Troubleshooting

### Login Opens Browser But Nothing Happens

- Check that `obsidian://` protocol is registered on your system
- Verify control plane URL is correct in settings
- Check browser console for errors

### "Unauthorized" Error

- Ensure you're logged in (check `/api/whoami`)
- Session may have expired - try logging in again
- Check control plane logs for authentication errors

### User Not Created in Database

- Check OIDC provider returns `sub`, `email`, and `name` in profile
- Verify database connection in control plane
- Check control plane logs for database errors

### Token Generation Fails

- Ensure Auth Private Key is configured in control plane (Configuration global)
- Verify relay ID matches a relay you have access to
- Check control plane logs for token generation errors

## Development

### Testing Locally

1. Run control plane with Auth.js configured:
   ```bash
   cd obsidian-relay-control
   pnpm dev
   ```

2. Configure OIDC provider (Keycloak recommended for testing)

3. Update plugin settings to point to local control plane:
   ```
   Control Plane URL: http://localhost:3000
   ```

4. Test login flow and token generation

### Debugging

Enable debug logging in the plugin:
```typescript
// In main.ts
console.log('Login URL:', this.loginManager.getLoginUrl());
console.log('User info:', await this.loginManager.getUser());
```

Check control plane logs:
```bash
# In control plane directory
pnpm dev
# Watch for Auth.js and token generation logs
```

## Migration from Passport.js Version

If upgrading from the Passport.js version:

1. Update plugin to this version
2. Update control plane to Auth.js version
3. Re-authenticate (existing sessions will be invalid)
4. No data migration needed - tokens continue to work

## Related Projects

- **Control Plane**: https://github.com/cortex-reply/obsidian-relay-control
- **Relay Server**: https://github.com/cortex-reply/obsidian-relay-server

## Support

For issues:
- **Plugin**: Open issue in obsidian-relay-client repository
- **Control Plane**: Open issue in obsidian-relay-control repository
- **Auth.js**: Check Auth.js documentation at https://authjs.dev
