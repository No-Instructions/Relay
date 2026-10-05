/// <reference path="../pb_data/types.d.ts" />

// Shared by the *.pb.js files. PocketBase runs every handler in its own
// runtime, so handlers require() this instead of using file-level names.

const PROVIDER_ID = "relayprovider01";
const ROLE = { OWNER: "2arnubkcv7jpce8", MEMBER: "x6lllh2qsf9lxk6" };
const READER = "Reader";
const INVITE_KEY_LENGTH = 20;
const DEFAULT_USER_LIMIT = 100;

const AUTHZ = { FULL: "full", READ_ONLY: "read-only" };
const TOKEN = { DOCUMENT: "document", FILE: "file" };

// y-sign tokens live 60 minutes (y-sweet-core auth.rs DEFAULT_EXPIRATION_SECONDS).
const TOKEN_TTL_MS = 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function findOne(collection, filter, params) {
  try {
    return $app.findFirstRecordByFilter(collection, filter, params);
  } catch (_) {
    return null;
  }
}

function create(app, collection, data) {
  const record = new Record(app.findCollectionByNameOrId(collection));
  for (const [key, value] of Object.entries(data)) record.set(key, value);
  app.save(record);
  return record;
}

function inviteKey() {
  return $security.randomString(INVITE_KEY_LENGTH);
}

function isReader(roleId) {
  return $app.findRecordById("roles", roleId).get("name") === READER;
}

// What the user may do in a folder. Relay and folder ids are the guids the
// plugin puts in its S3RN, not record ids.
function access(userId, relayGuid, folderGuid) {
  const relay = findOne("relays", "guid = {:guid}", { guid: relayGuid });
  if (!relay) throw new ForbiddenError("Unknown relay.");

  const role = findOne("relay_roles", "user = {:user} && relay = {:relay}", { user: userId, relay: relay.id });
  if (!role) throw new ForbiddenError("Not a member of this relay.");

  const folder = findOne("shared_folders", "guid = {:guid} && relay = {:relay}", { guid: folderGuid, relay: relay.id });
  if (!folder) throw new ForbiddenError("Unknown folder.");

  const folderRole = findOne("shared_folder_roles", "user = {:user} && shared_folder = {:folder}", {
    user: userId,
    folder: folder.id,
  });
  if (folder.getBool("private") && folder.get("creator") !== userId && !folderRole) {
    throw new ForbiddenError("Private folder.");
  }

  const readOnly = isReader(role.get("role")) || (folderRole && isReader(folderRole.get("role")));
  return readOnly ? AUTHZ.READ_ONLY : AUTHZ.FULL;
}

// Docs live on relay-server as "<relayGuid>-<guid>" (relay-server subdocs.rs).
function serverDocId(relayGuid, guid) {
  return relayGuid + "-" + guid;
}

// Signs with y-sign; the request JSON goes through an env var to avoid quoting.
function sign(request) {
  const cmd = $os.cmd("sh", "-c", 'printf %s "$REQ" | y-sign sign --key-type eddsa --audience "$AUD"');
  cmd.env = [
    "PATH=" + $os.getenv("PATH"),
    "RELAY_SERVER_AUTH=" + $os.getenv("RELAY_SERVER_AUTH"),
    "AUD=" + relayUrl(),
    "REQ=" + JSON.stringify(request),
  ];
  return JSON.parse(toString(cmd.output())).token;
}

function relayUrl() {
  return $os.getenv("RELAY_SERVER_URL").replace(/\/+$/, "");
}

module.exports = {
  PROVIDER_ID,
  ROLE,
  DEFAULT_USER_LIMIT,
  TOKEN,
  TOKEN_TTL_MS,
  UUID,
  SHA256,
  findOne,
  create,
  inviteKey,
  access,
  serverDocId,
  sign,
  relayUrl,
};
