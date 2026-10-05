/// <reference path="../pb_data/types.d.ts" />

// Collections the plugin reads and writes. Fields mirror src/RelayManager.ts
// DAOs. Rules: see PLAN-sentrisense-control-plane.md Section 5.

const AUTHED = '@request.auth.id != ""';
const OWN = "user = @request.auth.id";
const MEMBER = "relay_roles_via_relay.user ?= @request.auth.id";
const RELAY_MEMBER = "relay." + MEMBER;
const RELAY_CREATOR = "relay.creator = @request.auth.id";
const FOLDER_ADMIN =
  "shared_folder.creator = @request.auth.id || shared_folder.relay.creator = @request.auth.id";

const ROLES = { Owner: "2arnubkcv7jpce8", Member: "x6lllh2qsf9lxk6", Reader: "readerrole00001" };

// Client-chosen ids: devices use 15 [a-z0-9], vaults use Obsidian's appId.
const CLIENT_ID = { pattern: "^[a-zA-Z0-9_-]+$", min: 1, max: 64 };

const text = (name) => ({ type: "text", name });
const num = (name) => ({ type: "number", name });
const bool = (name) => ({ type: "bool", name });
const stamps = [
  { type: "autodate", name: "created", onCreate: true },
  { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
];

const BASE = {
  roles: [text("name")],
  providers: [text("url"), text("name"), bool("self_hosted"), text("public_key"), text("key_type"), text("key_id")],
  storage_quotas: [text("name"), num("quota"), num("usage"), num("pending"), bool("metered"), num("max_file_size")],
  relays: [text("guid"), text("name"), num("version"), text("path"), num("user_limit"), text("cta"), text("plan")],
  shared_folders: [text("guid"), text("name"), bool("private")],
  relay_roles: [],
  shared_folder_roles: [],
  relay_invitations: [text("key"), bool("enabled")],
  subscriptions: [bool("active"), { type: "date", name: "cancel_at" }, num("quantity"), text("token")],
  devices: [text("name"), text("platform")],
  vaults: [],
};

// Tokens look relays up by the client-chosen guid, so it must be unique.
const INDEXES = {
  relays: ["CREATE UNIQUE INDEX idx_relays_guid ON relays (guid)"],
  shared_folders: ["CREATE UNIQUE INDEX idx_shared_folders_guid ON shared_folders (relay, guid)"],
};

// [collection, field, target, cascadeDelete]
const RELATIONS = [
  ["relays", "creator", "users", false],
  ["relays", "provider", "providers", false],
  ["relays", "storage_quota", "storage_quotas", false],
  ["shared_folders", "creator", "users", false],
  ["shared_folders", "relay", "relays", true],
  ["relay_roles", "user", "users", true],
  ["relay_roles", "role", "roles", false],
  ["relay_roles", "relay", "relays", true],
  ["shared_folder_roles", "user", "users", true],
  ["shared_folder_roles", "role", "roles", false],
  ["shared_folder_roles", "shared_folder", "shared_folders", true],
  ["relay_invitations", "role", "roles", false],
  ["relay_invitations", "relay", "relays", true],
  ["subscriptions", "user", "users", false],
  ["subscriptions", "relay", "relays", true],
  ["devices", "user", "users", true],
  ["vaults", "device", "devices", true],
  ["vaults", "user", "users", true],
];

// [list/view, create, update, delete]; null = superusers and hooks only.
const RULES = {
  roles: [AUTHED, null, null, null],
  providers: [AUTHED, null, null, null],
  storage_quotas: [AUTHED, null, null, null],
  subscriptions: [AUTHED, null, null, null],
  relays: [MEMBER, AUTHED, "creator = @request.auth.id", "creator = @request.auth.id"],
  relay_roles: [RELAY_MEMBER, null, RELAY_CREATOR, RELAY_CREATOR + " || " + OWN],
  relay_invitations: [RELAY_MEMBER, null, RELAY_CREATOR, null],
  shared_folders: [
    RELAY_MEMBER,
    RELAY_MEMBER + " && creator = @request.auth.id",
    "creator = @request.auth.id || " + RELAY_CREATOR,
    "creator = @request.auth.id || " + RELAY_CREATOR,
  ],
  shared_folder_roles: ["shared_folder." + RELAY_MEMBER, FOLDER_ADMIN, FOLDER_ADMIN, FOLDER_ADMIN],
  devices: [OWN, "@request.body.user = @request.auth.id", OWN, null],
  vaults: [OWN, "@request.body.user = @request.auth.id", OWN, null],
};

migrate((app) => {
  for (const [name, fields] of Object.entries(BASE)) {
    app.save(new Collection({ type: "base", name, fields: [...fields, ...stamps] }));
  }

  for (const name of ["devices", "vaults"]) {
    const col = app.findCollectionByNameOrId(name);
    Object.assign(col.fields.getByName("id"), CLIENT_ID);
    app.save(col);
  }

  // Relations need target ids, so they go in after every collection exists.
  for (const [name, field, target, cascadeDelete] of RELATIONS) {
    const col = app.findCollectionByNameOrId(name);
    const collectionId = app.findCollectionByNameOrId(target).id;
    col.fields.add(new RelationField({ name: field, collectionId, maxSelect: 1, cascadeDelete }));
    app.save(col);
  }

  for (const [name, indexes] of Object.entries(INDEXES)) {
    const col = app.findCollectionByNameOrId(name);
    col.indexes = indexes;
    app.save(col);
  }

  // Rules last: they reference back-relations such as relay_roles_via_relay.
  for (const [name, [read, create, update, del]] of Object.entries(RULES)) {
    const col = app.findCollectionByNameOrId(name);
    col.listRule = read;
    col.viewRule = read;
    col.createRule = create;
    col.updateRule = update;
    col.deleteRule = del;
    app.save(col);
  }

  // OAuth2 sign-up runs the create rule, so allow it and nothing else.
  const users = app.findCollectionByNameOrId("users");
  users.listRule = AUTHED;
  users.viewRule = AUTHED;
  users.createRule = '@request.context = "oauth2"';
  users.updateRule = "id = @request.auth.id";
  users.deleteRule = null;
  app.save(users);

  const roles = app.findCollectionByNameOrId("roles");
  for (const [name, id] of Object.entries(ROLES)) {
    const record = new Record(roles);
    record.set("id", id);
    record.set("name", name);
    app.save(record);
  }
}, (app) => {
  for (const name of Object.keys(BASE).reverse()) {
    app.delete(app.findCollectionByNameOrId(name));
  }
});
