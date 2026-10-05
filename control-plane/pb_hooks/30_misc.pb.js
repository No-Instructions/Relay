/// <reference path="../pb_data/types.d.ts" />

// Small endpoints the plugin calls. Any 200 on /health means online.

routerAdd("GET", "/health", (e) => e.json(200, {}));

routerAdd("GET", "/whoami", (e) => e.json(200, { id: e.auth.id, email: e.auth.email() }), $apis.requireAuth("users"));

routerAdd("GET", "/flags", (e) => e.json(200, []), $apis.requireAuth("users"));

// Only level "warning" renders in the plugin.
routerAdd("GET", "/relay/{guid}/check-host", (e) => e.json(200, { level: "ok" }), $apis.requireAuth("users"));
