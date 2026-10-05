/// <reference path="../pb_data/types.d.ts" />

// Applies env config on every start: the Authentik OIDC login and the single
// relay-server provider row. JS hooks have no onServe, and bootstrap runs
// before serve migrates, so migrate here first.
onBootstrap((e) => {
  e.next();

  const { PROVIDER_ID, relayUrl } = require(`${__hooks}/relay.js`);
  const issuer = $os.getenv("OIDC_ISSUER");
  $app.runAllMigrations();

  // The plugin only shows providers named github, google, microsoft or oidc.
  const users = $app.findCollectionByNameOrId("users");
  unmarshal(
    {
      passwordAuth: { enabled: false },
      oauth2: {
        enabled: true,
        mappedFields: { name: "name", avatarURL: "avatar" },
        providers: [
          {
            name: "oidc",
            displayName: "Sentrisense",
            pkce: true,
            clientId: $os.getenv("OIDC_CLIENT_ID"),
            clientSecret: $os.getenv("OIDC_CLIENT_SECRET"),
            authURL: issuer + "authorize/",
            tokenURL: issuer + "token/",
            userInfoURL: issuer + "userinfo/",
          },
        ],
      },
    },
    users,
  );
  $app.save(users);

  // Empty public_key hides the plugin's "copy this relay.toml" block.
  const providers = $app.findCollectionByNameOrId("providers");
  let provider;
  try {
    provider = $app.findRecordById(providers, PROVIDER_ID);
  } catch (_) {
    provider = new Record(providers);
    provider.set("id", PROVIDER_ID);
  }
  provider.set("url", relayUrl());
  provider.set("name", "Sentrisense");
  provider.set("self_hosted", true);
  provider.set("key_type", "eddsa");
  provider.set("public_key", "");
  provider.set("key_id", "");
  $app.save(provider);
});

// New users: members see each other's email in the share dialogs. PocketBase
// drops emails Authentik marks unverified; keep them for sign-up only, since
// account linking still uses the verified email alone.
onRecordAuthWithOAuth2Request((e) => {
  if (e.isNewRecord) {
    const email = e.oAuth2User.email || e.oAuth2User.rawUser.email;
    e.createData = Object.assign({}, e.createData, { email, emailVisibility: true });
  }
  e.next();
}, "users");
