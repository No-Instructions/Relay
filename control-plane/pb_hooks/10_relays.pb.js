/// <reference path="../pb_data/types.d.ts" />

// The plugin sends only guid, name and path; the server owns the rest.
onRecordCreateRequest((e) => {
  const { PROVIDER_ID, DEFAULT_USER_LIMIT } = require(`${__hooks}/relay.js`);
  if (e.hasSuperuserAuth()) return e.next();

  e.record.set("creator", e.auth.id);
  e.record.set("provider", PROVIDER_ID);
  e.record.set("version", 1);
  e.record.set("user_limit", DEFAULT_USER_LIMIT);
  e.record.set("plan", "self-hosted");
  e.record.set("cta", "");
  e.next();
}, "relays");

// Runs before the create response is built, so its expands see these rows.
onRecordAfterCreateSuccess((e) => {
  const { ROLE, create, inviteKey } = require(`${__hooks}/relay.js`);
  const creator = e.record.get("creator");
  if (!creator) return e.next();

  create(e.app, "relay_roles", { user: creator, role: ROLE.OWNER, relay: e.record.id });
  create(e.app, "relay_invitations", { relay: e.record.id, role: ROLE.MEMBER, key: inviteKey(), enabled: true });
  e.next();
}, "relays");

routerAdd(
  "POST",
  "/api/accept-invitation",
  (e) => {
    const { findOne, create } = require(`${__hooks}/relay.js`);
    const key = String(e.requestInfo().body.key || "");
    if (!key) throw new BadRequestError("Missing key.");

    const invitation = findOne("relay_invitations", "key = {:key} && enabled = true", { key });
    if (!invitation) throw new NotFoundError("Invalid or disabled invitation.");

    const relayId = invitation.get("relay");
    const member = findOne("relay_roles", "user = {:user} && relay = {:relay}", { user: e.auth.id, relay: relayId });
    if (!member) create($app, "relay_roles", { user: e.auth.id, role: invitation.get("role"), relay: relayId });

    const relay = $app.findRecordById("relays", relayId);
    $apis.enrichRecord(e, relay, "relay_roles_via_relay", "shared_folders_via_relay", "storage_quota");
    return e.json(200, relay);
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/rotate-key",
  (e) => {
    const { findOne, inviteKey } = require(`${__hooks}/relay.js`);
    const id = String(e.requestInfo().body.id || "");

    const invitation = findOne("relay_invitations", "id = {:id}", { id });
    if (!invitation) throw new NotFoundError("Unknown invitation.");

    const relay = $app.findRecordById("relays", invitation.get("relay"));
    if (relay.get("creator") !== e.auth.id) throw new ForbiddenError("Only the relay owner can rotate the key.");

    invitation.set("key", inviteKey());
    $app.save(invitation);
    return e.json(200, invitation);
  },
  $apis.requireAuth("users"),
);
