const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Exercise the real route, protobuf, encryption and signatures. Only the session,
// database and remote HTTP boundary are substituted.
function loadTs(filename, overrides = {}, cache = new Map()) {
  filename = path.resolve(__dirname, "..", filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    const source = specifier.startsWith("@/")
      ? path.resolve(__dirname, "../src", specifier.slice(2)) + ".ts"
      : specifier.startsWith(".") ? path.resolve(path.dirname(filename), specifier) + ".ts" : null;
    if (source && fs.existsSync(source)) return loadTs(source, overrides, cache);
    return originalRequire(specifier);
  };
  cache.set(filename, loaded);
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const keys = loadTs("src/lib/crypto.ts");
const proto = loadTs("src/lib/proto.ts");
const protocol = loadTs("src/lib/protocol-auth.ts");
const ecies = loadTs("src/lib/ecies.ts");
const secret = "console-route-test-secret";
function identity() {
  const ed = crypto.generateKeyPairSync("ed25519");
  const x = crypto.generateKeyPairSync("x25519");
  const edPublic = ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const xPublic = x.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const xPrivate = x.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return { ed, x, edPublic, xPublic, xPrivate, urn: keys.deriveUrnFromEd25519PubKey(edPublic.toString("hex")) };
}
const owner = identity();
const alice = identity();
const bob = identity();
const stranger = identity();
const virtualUser = {
  id: "user-1", virtualUrn: owner.urn,
  virtualEd25519PublicKey: owner.edPublic.toString("hex"),
  virtualX25519PublicKey: owner.xPublic.toString("hex"),
  virtualEd25519PrivateKey: JSON.stringify(keys.encryptPrivateKey(owner.ed.privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"), secret)),
  virtualX25519PrivateKey: JSON.stringify(keys.encryptPrivateKey(owner.x.privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"), secret)),
};
const boundAgents = [
  { id: "agent-a", urn: alice.urn, userId: virtualUser.id },
  { id: "agent-b", urn: bob.urn, userId: virtualUser.id },
];
function registryRecord(sender = alice) {
  const record = {
    urn: sender.urn, peerId: protocol.peerIdFromEd25519PublicKey(sender.edPublic),
    x25519Pubkey: sender.xPublic, ed25519Pubkey: sender.edPublic,
    timestamp: Math.floor(Date.now() / 1000), storesUserData: false,
  };
  return {
    found: true, urn: record.urn, peer_id: record.peerId,
    x25519_pubkey: record.x25519Pubkey.toString("base64"), ed25519_pubkey: record.ed25519Pubkey.toString("base64"),
    signature: crypto.sign(null, protocol.buildRegistrationSigningBytes(record), sender.ed.privateKey).toString("base64"),
    timestamp: record.timestamp, stores_user_data: false, expires_at: String(record.timestamp + 7200),
  };
}
function incoming(sender = alice, text = "Hermes reply", change = {}) {
  const sharedSecret = ecies.computeSharedSecret(sender.xPrivate, owner.xPublic);
  const encrypted = ecies.encryptWithSharedSecret(sharedSecret,
    proto.encodeChatMessage(text, Date.now(), { conversationId: "console-fixture", inReplyTo: "request-1", kind: "reply" }));
  const envelope = protocol.signEnvelope({
    senderUrn: sender.urn, recipientUrn: owner.urn, senderStaticPubkey: sender.xPublic,
    ephemeralPubkey: encrypted.ephemeral, nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext, tag: encrypted.tag, messageId: crypto.randomUUID(), ...change,
  }, sender.ed.privateKey);
  return { message_id: envelope.messageId, payload_proto: proto.encodeEncryptedEnvelope(envelope).toString("base64") };
}
function verifyBody(init) {
  const [, signature, publicKey] = /^Ed25519 ([0-9a-f]+):([0-9a-f]+)$/.exec(init.headers.Authorization);
  assert.equal(publicKey, owner.edPublic.toString("hex"));
  assert.ok(crypto.verify(null, Buffer.from(init.body), owner.ed.publicKey, Buffer.from(signature, "hex")));
  return JSON.parse(init.body);
}
function fixture(queue = []) {
  const state = {
    queue, rows: new Map(), events: [], ackFailure: false, databaseFailure: false,
    registry: registryRecord(), storeResult: null, retrieveStatus: 200, session: { user: { id: virtualUser.id } },
  };
  const prisma = {
    user: { findUnique: async () => virtualUser },
    agent: {
      findFirst: async ({ where }) => boundAgents.find((a) => a.id === where.id && a.userId === where.userId) || null,
      findMany: async ({ where }) => boundAgents.filter((a) => a.userId === where.userId),
    },
    message: {
      create: async ({ data }) => {
        if (state.databaseFailure) throw new Error("Database unavailable");
        const id = data.id || crypto.randomUUID();
        if (state.rows.has(id)) throw Object.assign(new Error("Duplicate ID"), { code: "P2002" });
        const row = { ...data, id, createdAt: data.createdAt || new Date() };
        state.rows.set(id, row);
        state.events.push({ operation: "persist", row });
        return row;
      },
      findUnique: async ({ where }) => state.rows.get(where.id) || null,
      findMany: async ({ where }) => [...state.rows.values()].filter((row) =>
        row.userId === where.userId && (!where.agentId || row.agentId === where.agentId) &&
        (!where.OR || where.OR.some((pair) => pair.senderUrn === row.senderUrn && pair.recipientUrn === row.recipientUrn))),
    },
  };
  const route = loadTs("src/app/api/messages/route.ts", {
    "next-auth": { getServerSession: async () => state.session }, "@/lib/db": { prisma }, "@/lib/auth": { authOptions: {} },
  });
  state.fetch = async (url, init) => {
    if (url.includes("/registry/resolve")) return Response.json(state.registry);
    if (url.endsWith("/mq/retrieve")) {
      assert.equal(init.headers["X-URN"], owner.urn);
      const timestamp = Buffer.alloc(8);
      timestamp.writeBigInt64BE(BigInt(init.headers["X-Timestamp"]));
      assert.ok(crypto.verify(null, Buffer.concat([Buffer.from(`mq-retrieve|${owner.urn}|`), timestamp]),
        owner.ed.publicKey, Buffer.from(init.headers["X-Signature"], "hex")));
      return state.retrieveStatus === 200 ? Response.json({ messages: state.queue }) : new Response("retrieve rejected", { status: state.retrieveStatus });
    }
    if (url.endsWith("/mq/ack")) {
      const body = verifyBody(init);
      assert.equal(body.recipient_urn, owner.urn);
      assert.ok(Math.abs(Date.now() / 1000 - body.timestamp) < 10);
      assert.ok(state.rows.size > 0, "ACK must follow durable storage");
      state.events.push({ operation: "ack", body });
      return state.ackFailure ? new Response("ack rejected", { status: 503 }) : Response.json({ ok: true, deleted: body.message_ids.length });
    }
    if (url.endsWith("/mq/store")) {
      const body = verifyBody(init);
      const envelope = proto.decodeEncryptedEnvelope(Buffer.from(body.payload_proto, "base64"));
      protocol.verifyEnvelope(envelope, alice.urn);
      assert.equal(body.recipient_urn, alice.urn);
      const plaintext = ecies.decryptWithSharedSecret(ecies.computeSharedSecret(alice.xPrivate, owner.xPublic),
        envelope.ephemeralPubkey, envelope.nonce, envelope.ciphertext, envelope.tag);
      state.events.push({ operation: "store", envelope, message: proto.decodeChatMessage(plaintext) });
      return Response.json(state.storeResult || { ok: true, message_id: envelope.messageId });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  state.get = (agent = boundAgents[0]) => route.GET(new Request(`http://localhost/api/messages?agentId=${agent.id}&contactUrn=${encodeURIComponent(agent.urn)}`));
  state.post = () => route.POST(new Request("http://localhost/api/messages", {
    method: "POST", body: JSON.stringify({ agentId: "agent-a", recipientUrn: alice.urn, content: "Hello Hermes" }),
  }));
  return state;
}

test("console messaging uses authenticated agent-comm and durable routing", { concurrency: false }, async (t) => {
  const oldFetch = global.fetch;
  const oldSecret = process.env.NEXTAUTH_SECRET;
  const oldConsoleError = console.error;
  process.env.NEXTAUTH_SECRET = secret;
  console.error = () => {};
  const use = (state) => { global.fetch = state.fetch; return state; };
  try {
    await t.test("POST encrypts to the registered agent and signs both envelope and MQ request", async () => {
      const state = use(fixture());
      const response = await state.post();
      assert.equal(response.status, 201);
      const stored = state.events.find((e) => e.operation === "store");
      assert.equal(stored.message.text, "Hello Hermes");
      assert.match(stored.message.conversationId, /^web-console-/);
      assert.equal(stored.message.kind, "request");
      assert.deepEqual(state.events.map((e) => e.operation), ["store", "persist"]);
      assert.equal((await response.json()).message.senderUrn, owner.urn);
    });
    await t.test("POST rejects forged registry keys before storing any message", async () => {
      const state = use(fixture());
      state.registry.x25519_pubkey = stranger.xPublic.toString("base64");
      assert.equal((await state.post()).status, 502);
      assert.equal(state.rows.size, 0);
      assert.equal(state.events.length, 0);
    });
    for (const result of [{ ok: false }, { ok: true, message_id: "wrong-id" }]) {
      await t.test(`POST requires confirmation for its exact message (${JSON.stringify(result)})`, async () => {
        const state = use(fixture());
        state.storeResult = result;
        assert.equal((await state.post()).status, 502);
        assert.equal(state.rows.size, 0);
      });
    }
    await t.test("GET routes simultaneous A and B replies by sender while the B tab polls", async () => {
      const state = use(fixture([incoming(alice, "A reply"), incoming(bob, "B reply")]));
      const response = await state.get(boundAgents[1]);
      assert.equal(response.status, 200);
      const messages = await response.json();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "B reply");
      assert.equal(messages[0].agentId, "agent-b");
      assert.equal([...state.rows.values()].find((row) => row.content === "A reply").agentId, "agent-a");
      assert.deepEqual(state.events.map((e) => e.operation), ["persist", "persist", "ack"]);
    });
    await t.test("GET retries a failed ACK without duplicating the saved reply", async () => {
      const state = use(fixture([incoming()]));
      state.ackFailure = true;
      const failed = await state.get();
      assert.equal(failed.status, 502);
      assert.match((await failed.json()).error, /503/);
      state.ackFailure = false;
      assert.equal((await state.get()).status, 200);
      assert.equal(state.rows.size, 1);
      assert.equal(state.events.filter((e) => e.operation === "persist").length, 1);
      assert.equal(state.events.filter((e) => e.operation === "ack").length, 2);
    });
    await t.test("simultaneous GET requests persist one copy and safely acknowledge both polls", async () => {
      const state = use(fixture([incoming()]));
      const responses = await Promise.all([state.get(), state.get()]);
      assert.deepEqual(responses.map((r) => r.status), [200, 200]);
      assert.equal(state.rows.size, 1);
    });
    await t.test("database failures do not acknowledge a reply", async () => {
      const state = use(fixture([incoming()]));
      state.databaseFailure = true;
      assert.equal((await state.get()).status, 500);
      assert.equal(state.events.length, 0);
    });
    await t.test("replies from agents not bound to the current user are neither saved nor acknowledged", async () => {
      const state = use(fixture([incoming(stranger)]));
      assert.equal((await state.get()).status, 200);
      assert.equal(state.rows.size, 0);
      assert.equal(state.events.length, 0);
    });
    await t.test("a forged envelope or relabelled MQ ID cannot enter chat history", async () => {
      const forged = incoming();
      const envelope = proto.decodeEncryptedEnvelope(Buffer.from(forged.payload_proto, "base64"));
      envelope.signature[0] ^= 1;
      forged.payload_proto = proto.encodeEncryptedEnvelope(envelope).toString("base64");
      const relabelled = incoming();
      relabelled.message_id = "not-the-signed-id";
      const wrongRecipient = incoming(alice, "wrong destination", { recipientUrn: bob.urn });
      const state = use(fixture([forged, relabelled, wrongRecipient]));
      assert.equal((await state.get()).status, 502);
      assert.equal(state.rows.size, 0);
      assert.equal(state.events.length, 0);
    });
    await t.test("GET exposes MQ authorization errors instead of silently reporting an empty mailbox", async () => {
      const state = use(fixture());
      state.retrieveStatus = 401;
      const response = await state.get();
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /401/);
    });
    await t.test("an unowned agent or missing session cannot poll the virtual mailbox", async () => {
      const state = use(fixture());
      assert.equal((await state.get({ id: "not-owned", urn: stranger.urn })).status, 404);
      state.session = null;
      assert.equal((await state.get()).status, 401);
      assert.equal((await state.post()).status, 401);
      assert.equal(state.events.length, 0);
    });
  } finally {
    global.fetch = oldFetch;
    console.error = oldConsoleError;
    if (oldSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = oldSecret;
  }
});
