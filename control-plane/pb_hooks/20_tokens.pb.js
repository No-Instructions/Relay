/// <reference path="../pb_data/types.d.ts" />

// Doc and file tokens for relay-server, signed here with y-sign.
// `device` and `supersede` in the body are accepted and ignored.

routerAdd(
  "POST",
  "/token",
  (e) => {
    const lib = require(`${__hooks}/relay.js`);
    const b = e.requestInfo().body;
    if (![b.docId, b.relay, b.folder].every((id) => lib.UUID.test(id))) {
      throw new BadRequestError("docId, relay and folder must be UUIDs.");
    }

    const authorization = lib.access(e.auth.id, b.relay, b.folder);
    const docId = lib.serverDocId(b.relay, b.docId);
    const expiryTime = Date.now() + lib.TOKEN_TTL_MS;

    // Docs inside a folder report their updates on the folder's channel.
    const request = { type: lib.TOKEN.DOCUMENT, docId, authorization, user: e.auth.id };
    if (b.docId !== b.folder) request.channel = lib.serverDocId(b.relay, b.folder);

    const base = lib.relayUrl();
    return e.json(200, {
      url: base.replace(/^http/, "ws") + "/d/" + docId + "/ws",
      baseUrl: base + "/d/" + docId,
      docId,
      folder: b.folder,
      token: lib.sign(request),
      authorization,
      expiryTime,
    });
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/file-token",
  (e) => {
    const lib = require(`${__hooks}/relay.js`);
    const b = e.requestInfo().body;
    if (![b.docId, b.relay, b.folder].every((id) => lib.UUID.test(id)) || !lib.SHA256.test(b.hash)) {
      throw new BadRequestError("docId, relay and folder must be UUIDs and hash a SHA-256 hex digest.");
    }

    const authorization = lib.access(e.auth.id, b.relay, b.folder);
    const docId = lib.serverDocId(b.relay, b.docId);
    const expiryTime = Date.now() + lib.TOKEN_TTL_MS;

    const token = lib.sign({
      type: lib.TOKEN.FILE,
      docId,
      fileHash: b.hash,
      authorization,
      contentType: b.contentType,
      contentLength: b.contentLength,
      user: e.auth.id,
    });

    const base = lib.relayUrl() + "/f/" + docId;
    return e.json(200, {
      url: base,
      baseUrl: base,
      docId,
      folder: b.folder,
      token,
      authorization,
      expiryTime,
      contentType: b.contentType,
      contentLength: b.contentLength,
      fileHash: b.hash,
    });
  },
  $apis.requireAuth("users"),
);
