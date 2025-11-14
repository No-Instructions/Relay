# Obsidian Relay Plugin (Self-Hosted)

This is a modified version of the Obsidian Relay plugin that works with a self-hosted control plane instead of System3's infrastructure.

## Features

- **OIDC Authentication**: Simplified login using OpenID Connect (Keycloak)
- **Self-Hosted**: Works with your own control plane and relay server
- **Token Management**: Automatic token generation and caching
- **No External Dependencies**: All functionality runs on your infrastructure

## Installation

### Prerequisites

- Obsidian v0.15.0 or higher
- Self-hosted control plane (see [obsidian-relay-control](https://github.com/cortex-reply/obsidian-relay-control))
- Self-hosted relay server (see [obsidian-relay-server](https://github.com/cortex-reply/obsidian-relay-server))

### Building from Source

1. Clone this repository:

```bash
git clone https://github.com/cortex-reply/obsidian-relay-client-modified.git
cd obsidian-relay-client-modified
```

2. Install dependencies:

```bash
npm install
```

3. Build the plugin:

```bash
npm run build
```

4. Copy the built files to your Obsidian vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/relay-selfhosted
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/relay-selfhosted/
```

### Manual Installation

1. Download the latest release from the releases page
2. Extract the files to your vault's plugins folder: `/path/to/vault/.obsidian/plugins/relay-selfhosted/`
3. Enable the plugin in Obsidian Settings → Community Plugins

## Configuration

1. Open Obsidian Settings → Relay (Self-Hosted)
2. Enter your control plane URL (e.g., `https://control.example.com`)
3. Enter your relay ID (from your control plane dashboard)
4. Click "Sign In" to authenticate

## Usage

### Signing In

1. Click the cloud icon in the ribbon, or
2. Use the command palette: "Relay: Sign In"
3. Your browser will open to the control plane login page
4. Sign in with your credentials
5. You'll be redirected back to Obsidian

### Collaboration

Once signed in and configured, the plugin will automatically:

1. Generate tokens for documents you open
2. Connect to the relay server
3. Enable real-time collaboration with other users

### Signing Out

1. Click the cloud icon in the ribbon (when signed in), or
2. Use the command palette: "Relay: Sign Out"

## Differences from Original Plugin

This modified version has the following changes:

1. **Removed System3 Dependencies**: All endpoints point to your control plane
2. **Simplified Authentication**: Only supports OIDC (no Google, GitHub, etc.)
3. **No Version Checks**: Updates are managed manually
4. **No License Validation**: All users are considered licensed
5. **Simplified Settings**: Only control plane URL and relay ID needed

## Troubleshooting

### "Not authenticated" Error

- Make sure you've signed in through the settings
- Check that your control plane URL is correct
- Try clearing the token cache in settings

### "No relay configured" Error

- Make sure you've entered a relay ID in settings
- Verify the relay ID exists in your control plane dashboard

### Connection Issues

- Verify your relay server is running and accessible
- Check that the relay server URL in your control plane configuration is correct
- Ensure your network allows WebSocket connections

### Token Generation Fails

- Verify you have access to the relay in your control plane
- Check that the authentication key matches between control plane and relay server
- Try signing out and signing in again

## Development

### Project Structure

```
src/
├── main.ts              # Main plugin file
├── EndpointManager.ts   # Endpoint configuration
├── LoginManager.ts      # OIDC authentication
├── TokenStore.ts        # Token management
└── SettingsTab.ts       # Settings UI
```

### Building for Development

```bash
npm run dev
```

This will watch for changes and rebuild automatically.

### Testing

1. Build the plugin
2. Copy to a test vault
3. Enable in Obsidian
4. Test authentication and collaboration

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Related Projects

- [Obsidian Relay Control Plane](https://github.com/cortex-reply/obsidian-relay-control) - Authentication and token generation
- [Obsidian Relay Server](https://github.com/cortex-reply/obsidian-relay-server) - y-sweet relay server

## Support

For issues and questions:

- GitHub Issues: https://github.com/cortex-reply/obsidian-relay-client-modified/issues
- Documentation: https://github.com/cortex-reply/obsidian-relay-control/wiki

## Acknowledgments

Based on the original Obsidian Relay plugin, modified for self-hosted deployments.

Built on top of:
- [Obsidian](https://obsidian.md) - Knowledge base application
- [Yjs](https://github.com/yjs/yjs) - CRDT framework
- [y-sweet](https://github.com/drifting-in-space/y-sweet) - CRDT relay server
