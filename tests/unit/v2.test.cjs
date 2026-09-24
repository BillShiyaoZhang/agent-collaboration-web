const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}
const proto = load("../../src/lib/protocol/proto.ts");
const auth = load("../../src/lib/protocol/protocol-auth.ts", { "@/lib/protocol/proto": proto });
const v2 = load("../../src/lib/protocol/v2.ts", { "@/lib/protocol/protocol-auth": auth });
const suite = load("../../src/lib/protocol/v2-crypto.ts", { "@/lib/protocol/v2": v2 });
const http = load("../../src/lib/protocol/v2-http.ts", { "@/lib/protocol/v2": v2, "@/lib/protocol/protocol-auth": auth });
const edRaw = key => crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
const xRaw = key => crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
const signJSON = (domain, unsigned, privateKey) => crypto.sign(null,
  Buffer.concat([Buffer.from(domain), Buffer.from(JSON.stringify({ ...unsigned, signature: null }))]), privateKey).toString("base64");
const base64 = bytes => bytes.toString("base64");

function fixture(mode = "compliance") {
  const root = crypto.generateKeyPairSync("ed25519"), issuer = crypto.generateKeyPairSync("ed25519");
  const receiptKey = crypto.generateKeyPairSync("ed25519"), sender = crypto.generateKeyPairSync("ed25519");
  const recipient = crypto.generateKeyPairSync("x25519"), gateway = crypto.generateKeyPairSync("x25519");
  const senderPublic = edRaw(sender.privateKey);
  const urn = `urn:hermes:agent:${base58(crypto.createHash("sha256").update(senderPublic).digest().subarray(0, 16))}`;
  const policy = {
    version: 2, platform_id: "platform-v2-test", epoch: 7, not_before: 1700000000, expires_at: 2300000000,
    mode, suite: "X25519-HKDF-SHA256-AES256GCM", gateway_key_id: mode === "compliance" ? "gateway-1" : "",
    gateway_public_key: mode === "compliance" ? base64(xRaw(gateway.privateKey)) : null,
    receipt_key_id: "receipt-1", receipt_public_key: base64(edRaw(receiptKey.privateKey)), allow_v1: false,
    managed_issuer_public_key: base64(edRaw(issuer.privateKey)),
  };
  const signature = signJSON("agent-comm-v2-policy\0", policy, root.privateKey);
  const rawPolicy = v2.encodeV2Policy({ ...policy, signature });
  return { root, issuer, receiptKey, sender, recipient, gateway, urn, policy: { ...policy, signature }, rawPolicy };
}
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(raw) {
  let number = BigInt(`0x${raw.toString("hex")}`), out = "";
  while (number > 0n) { out = BASE58[Number(number % 58n)] + out; number /= 58n; }
  for (const byte of raw) { if (byte !== 0) break; out = "1" + out; }
  return out;
}

test("v2 policy is pinned, canonical, current and rejects signature or disclosure changes", () => {
  const f = fixture();
  assert.deepEqual(v2.verifyV2Policy(f.rawPolicy, edRaw(f.root.privateKey), 1800000000), f.policy);
  for (const mutation of [
    { mode: "private" }, { allow_v1: true }, { gateway_public_key: null }, { receipt_public_key: null },
    { managed_issuer_public_key: base64(Buffer.alloc(1)) },
  ]) {
    const raw = v2.encodeV2Policy({ ...f.policy, ...mutation });
    assert.throws(() => v2.verifyV2Policy(raw, edRaw(f.root.privateKey), 1800000000));
  }
  assert.throws(() => v2.verifyV2Policy(f.rawPolicy, edRaw(crypto.generateKeyPairSync("ed25519").privateKey), 1800000000));
  assert.throws(() => v2.verifyV2Policy(f.rawPolicy, edRaw(f.root.privateKey), 2400000000));
  const object = JSON.parse(f.rawPolicy); // JSON.parse alone would silently keep the last duplicate value.
  const duplicate = Buffer.from(f.rawPolicy.toString().replace('"epoch":7', '"epoch":6,"epoch":7'));
  assert.equal(object.epoch, 7);
  assert.throws(() => v2.decodeV2Policy(duplicate), /Noncanonical/);
  assert.throws(() => v2.decodeV2Policy(Buffer.from(f.rawPolicy.toString().replace('"epoch":7', '"epoch":7,"extra":true'))));
});

test("v2 HPKE opens the same CEK at recipient and gateway, then authenticates one body", () => {
  const f = fixture();
  const header = { version: 2, platform_id: f.policy.platform_id, policy_epoch: 7, policy_hash: v2.v2Hash(f.rawPolicy),
    mode: "compliance", suite: f.policy.suite, sender_urn: f.urn, recipient_urn: "urn:hermes:agent:recipient-test",
    session_id: "session-1", direction: "a_to_b", sequence: 1, message_id: "message-1", expiry: 2200000000,
    content_type: v2.V2_AGENT_CONTENT_TYPE, recipient_key_id: "recipient-1", gateway_key_id: "", slot_roles: [] };
  const message = Buffer.from("same content to recipient and gateway");
  const { envelope: raw, cek } = suite.sealV2Compliance(f.policy, f.rawPolicy, header, message,
    xRaw(f.recipient.privateKey), f.sender.privateKey);
  const env = v2.verifyV2Envelope(raw, f.rawPolicy, edRaw(f.sender.privateKey), header.recipient_urn, 1800000000);
  const recipientPrivate = f.recipient.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const gatewayPrivate = f.gateway.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const opened = suite.openV2ComplianceRecipient(env, recipientPrivate);
  assert.deepEqual(opened.cek, cek);
  assert.deepEqual(opened.plaintext, message);
  const body = Buffer.from(env.ciphertext, "base64");
  const gatewaySlot = env.slots[1];
  const context = suite.v2SlotContext(env.header, body, gatewaySlot.role, gatewaySlot.key_id);
  assert.deepEqual(suite.hpkeOpen(gatewayPrivate, Buffer.from(gatewaySlot.enc, "base64"),
    Buffer.from(gatewaySlot.ciphertext, "base64"), context, context), cek);
  assert.throws(() => suite.hpkeOpen(gatewayPrivate, Buffer.from(gatewaySlot.enc, "base64"),
    Buffer.from(gatewaySlot.ciphertext, "base64"), context, Buffer.from("wrong")));
  const extra = { ...env, slots: [...env.slots, { ...env.slots[1], role: "fourth-party" }] };
  assert.throws(() => v2.verifyV2Envelope(v2.encodeV2Envelope(extra), f.rawPolicy, edRaw(f.sender.privateKey), header.recipient_urn, 1800000000));
  const opaque = { ...env, header: { ...env.header, content_type: "application/octet-stream" } };
  opaque.signature = signJSON("agent-comm-v2-envelope\0", opaque, f.sender.privateKey);
  assert.throws(() => v2.verifyV2Envelope(v2.encodeV2Envelope(opaque), f.rawPolicy,
    edRaw(f.sender.privateKey), header.recipient_urn, 1800000000), /policy/);
});

test("v2 receipt proves the gateway opened the recipient CEK, not merely signed the envelope", () => {
  const f = fixture();
  const header = { version: 2, platform_id: f.policy.platform_id, policy_epoch: 7, policy_hash: v2.v2Hash(f.rawPolicy),
    mode: "compliance", suite: f.policy.suite, sender_urn: f.urn, recipient_urn: "urn:hermes:agent:recipient-test",
    session_id: "session-1", direction: "a_to_b", sequence: 1, message_id: "message-1", expiry: 2200000000,
    content_type: v2.V2_AGENT_CONTENT_TYPE, recipient_key_id: "recipient-1", gateway_key_id: "", slot_roles: [] };
  const { envelope, cek } = suite.sealV2Compliance(f.policy, f.rawPolicy, header, Buffer.from("hello"), xRaw(f.recipient.privateKey), f.sender.privateKey);
  const proofKey = crypto.hkdfSync("sha256", cek, Buffer.alloc(32), Buffer.from("agent-comm-v2/admission-proof"), 32);
  const proof = crypto.createHmac("sha256", proofKey).update(crypto.createHash("sha256").update(envelope).digest()).digest();
  const unsigned = { version: 2, platform_id: f.policy.platform_id, envelope_hash: v2.v2Hash(envelope),
    policy_hash: v2.v2Hash(f.rawPolicy), gateway_key_id: f.policy.gateway_key_id, receipt_key_id: f.policy.receipt_key_id,
    admitted_at: 1800000000, result: "decrypted-admitted", proof: base64(proof) };
  const raw = v2.encodeV2Receipt({ ...unsigned, signature: signJSON("agent-comm-v2-receipt\0", unsigned, f.receiptKey.privateKey) });
  assert.equal(v2.verifyV2Receipt(raw, envelope, f.rawPolicy, cek, 1800000000).result, "decrypted-admitted");
  assert.throws(() => v2.verifyV2Receipt(raw, envelope, f.rawPolicy, Buffer.alloc(32), 1800000000), /proof/);
  assert.throws(() => v2.verifyV2Receipt(raw, Buffer.from("other"), f.rawPolicy, cek, 1800000000));
});

test("managed console certificate binds platform, self-certifying URN, issuer and lifetime", () => {
  const f = fixture();
  const raw = v2.signV2ManagedCertificate({ version: 2, role: "managed_console", platform_id: f.policy.platform_id,
    urn: f.urn, identity_public_key: base64(edRaw(f.sender.privateKey)), not_before: 1800000000,
    expires_at: 1800003600, serial: "fixture-serial" }, f.issuer.privateKey);
  assert.equal(v2.verifyV2ManagedCertificate(raw, f.rawPolicy, 1800000000).urn, f.urn);
  assert.throws(() => v2.verifyV2ManagedCertificate(raw, f.rawPolicy, 1800003600), /expired/);
  const wrong = { ...v2.decodeV2ManagedCertificate(raw), urn: "urn:hermes:agent:attacker" };
  assert.throws(() => v2.verifyV2ManagedCertificate(v2.encodeV2ManagedCertificate(wrong), f.rawPolicy, 1800000000));
});

test("managed v1 control requires explicit signed-policy consent and detects rollback", async () => {
  const f = fixture(), state = new Map(), grants = new Map(), consents = new Map(), pauses = new Map();
  const db = {
    platformPolicyState: {
      findUnique: async ({ where }) => state.get(where.platformId) || null,
      findFirst: async () => [...state.values()][0] || null,
      upsert: async ({ create, update }) => state.set(create.platformId, state.has(create.platformId) ? update : create),
    },
    managedConsoleCertificate: {
      findUnique: async ({ where }) => grants.get(where.userId) || null,
      upsert: async ({ where, create, update }) => grants.set(where.userId, grants.has(where.userId) ? update : create),
    },
    userPolicyConsent: {
      findUnique: async ({ where }) => consents.get(where.userId) || null,
      upsert: async ({ where, create, update }) => consents.set(where.userId, consents.has(where.userId) ? update : create),
    },
    userControlPause: {
      findUnique: async ({ where }) => pauses.get(where.userId) || null,
      upsert: async ({ where, create, update }) => pauses.set(where.userId, pauses.has(where.userId) ? update : create),
      deleteMany: async ({ where }) => { const count = Number(pauses.delete(where.userId)); return { count }; },
    },
  };
  const prisma = { ...db, $transaction: async callback => callback(db) };
  const gate = load("../../src/lib/control/v2-policy.ts", { "@/lib/shared/db": { prisma }, "@/lib/protocol/v2": v2 });
  const oldFetch = global.fetch;
  const prior = { root: process.env.AGENT_V2_POLICY_ROOT_PUBLIC_KEY, id: process.env.AGENT_V2_PLATFORM_ID,
    issuer: process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY, issuerFile: process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE };
  const issuerSeed = f.issuer.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const issuerRaw = Buffer.concat([issuerSeed, edRaw(f.issuer.privateKey)]);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "web-managed-issuer-")), keyFile = path.join(temp, "issuer.private");
  fs.writeFileSync(keyFile, issuerRaw);
  process.env.AGENT_V2_POLICY_ROOT_PUBLIC_KEY = edRaw(f.root.privateKey).toString("hex");
  process.env.AGENT_V2_PLATFORM_ID = f.policy.platform_id;
  delete process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE;
  process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY = issuerSeed.toString("hex");
  let policyRaw = f.rawPolicy, registrations = 0;
  global.fetch = async (url, init) => {
    if (url.endsWith("/api/v2/policy")) return Response.json({ policy: base64(policyRaw) });
    if (url.endsWith("/api/v2/managed/identity")) {
      registrations++;
      const body = JSON.parse(init.body);
      const certificate = v2.verifyV2ManagedCertificate(Buffer.from(body.certificate, "base64"), policyRaw);
      const [signature, key] = init.headers.Authorization.slice("Ed25519 ".length).split(":");
      assert.equal(key, edRaw(f.sender.privateKey).toString("hex"));
      assert.equal(crypto.verify(null, Buffer.from(init.body), f.sender.publicKey, Buffer.from(signature, "hex")), true);
      return Response.json({ ok: true, urn: certificate.urn, expires_at: certificate.expires_at });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const keys = { urn: f.urn, publicKey: edRaw(f.sender.privateKey).toString("hex"), signingKey: f.sender.privateKey };
  try {
    assert.equal((await gate.readPolicyDisclosure("account-1")).can_use_workbench, false);
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /先在工作台确认/);
    assert.equal(registrations, 0, "no managed enrollment before disclosure consent");
    await assert.rejects(gate.confirmPolicyDisclosure("account-1", "0".repeat(64)), /政策已变化/);
    assert.equal((await gate.confirmPolicyDisclosure("account-1", v2.v2Hash(policyRaw))).confirmed, true);
    await gate.pausePolicyUse("account-1");
    assert.equal((await gate.readPolicyDisclosure("account-1")).can_use_workbench, false);
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /已暂停/);
    await gate.resumePolicyUse("account-1");
    assert.equal((await gate.readPolicyDisclosure("account-1")).can_use_workbench, true);
    await gate.requireManagedV1({ id: "account-1" }, keys);
    assert.equal(registrations, 1);
    assert.equal(grants.get("account-1").platformId, f.policy.platform_id);
    await gate.requireManagedV1({ id: "account-1" }, keys);
    assert.equal(registrations, 1, "durable certificate is reused before renewal");
    process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY = issuerRaw.toString("hex");
    grants.clear();
    await gate.requireManagedV1({ id: "account-1" }, keys);
    assert.equal(registrations, 2, "Go 64-byte Ed25519 private key is accepted");
    delete process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY;
    process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE = keyFile;
    grants.clear();
    await gate.requireManagedV1({ id: "account-1" }, keys);
    assert.equal(registrations, 3, "Go keygen binary file is accepted");
    delete process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE;
    process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY = issuerSeed.toString("hex");
    await gate.pausePolicyUse("account-1");
    const changed = { ...f.policy, epoch: 8, signature: null };
    changed.signature = signJSON("agent-comm-v2-policy\0", changed, f.root.privateKey);
    policyRaw = v2.encodeV2Policy(changed);
    assert.equal((await gate.readPolicyDisclosure("account-1")).paused, true,
      "user pause persists across a signed policy change");
    assert.equal((await gate.readPolicyDisclosure("account-1")).can_use_workbench, false,
      "a new signed epoch never silently inherits old consent");
    await assert.rejects(gate.resumePolicyUse("account-1"), /重新确认/);
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /已暂停/);
    await gate.confirmPolicyDisclosure("account-1", v2.v2Hash(policyRaw));
    assert.equal((await gate.readPolicyDisclosure("account-1")).paused, false);
    await gate.requireManagedV1({ id: "account-1" }, keys);
    policyRaw = f.rawPolicy;
    const earlier = { ...f.policy, epoch: 6, signature: null };
    earlier.signature = signJSON("agent-comm-v2-policy\0", earlier, f.root.privateKey);
    policyRaw = v2.encodeV2Policy(earlier);
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /rollback/);
    policyRaw = v2.encodeV2Policy(changed);
    delete process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY;
    grants.clear();
    await gate.confirmPolicyDisclosure("account-2", v2.v2Hash(policyRaw));
    await assert.rejects(gate.requireManagedV1({ id: "account-2" }, keys), /issuer/);
    global.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /unavailable/);
    delete process.env.AGENT_V2_POLICY_ROOT_PUBLIC_KEY;
    await assert.rejects(gate.requireManagedV1({ id: "account-1" }, keys), /unavailable/, "previously seen v2 policy cannot be downgraded by clearing the root");
    state.clear(); delete process.env.AGENT_V2_PLATFORM_ID;
    await gate.requireManagedV1({ id: "account-1" }, keys); // Legacy platform only, no pinned v2 root.
  } finally {
    global.fetch = oldFetch;
    fs.unlinkSync(keyFile); fs.rmdirSync(temp);
    for (const [name, value] of Object.entries({ AGENT_V2_POLICY_ROOT_PUBLIC_KEY: prior.root,
      AGENT_V2_PLATFORM_ID: prior.id, AGENT_MANAGED_ISSUER_PRIVATE_KEY: prior.issuer,
      AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE: prior.issuerFile })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("Go v2 policy, HPKE envelope, receipt and managed certificate match TypeScript byte for byte", () => {
  // Regenerate in the Go SDK with: go run ./v2/testdata/generate.go
  const vector = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/protocol-v2-go.json"), "utf8"));
  const bytes = name => Buffer.from(vector[name], "base64");
  const policyRaw = bytes("policy"), envelopeRaw = bytes("envelope"), receiptRaw = bytes("receipt");
  const root = bytes("root_public_key"), sender = bytes("sender_public_key"), cek = bytes("cek");
  const policy = v2.verifyV2Policy(policyRaw, root, 2000000000);
  assert.deepEqual(v2.encodeV2Policy(policy), policyRaw);
  assert.equal(v2.v2Hash(policyRaw), vector.policy_hash);
  const envelope = v2.decodeV2Envelope(envelopeRaw);
  assert.deepEqual(v2.encodeV2Envelope(envelope), envelopeRaw);
  v2.verifyV2Envelope(envelopeRaw, policyRaw, sender, envelope.header.recipient_urn, 2000000000);
  assert.equal(v2.v2Hash(envelopeRaw), vector.envelope_hash);
  const opened = suite.openV2ComplianceRecipient(envelope, bytes("recipient_private_key"));
  assert.deepEqual(opened.cek, cek);
  assert.deepEqual(opened.plaintext, bytes("plaintext"));
  const gatewaySlot = envelope.slots[1];
  const context = suite.v2SlotContext(envelope.header, Buffer.from(envelope.ciphertext, "base64"), gatewaySlot.role, gatewaySlot.key_id);
  assert.deepEqual(suite.hpkeOpen(bytes("gateway_private_key"), Buffer.from(gatewaySlot.enc, "base64"),
    Buffer.from(gatewaySlot.ciphertext, "base64"), context, context), cek);
  const receipt = v2.verifyV2Receipt(receiptRaw, envelopeRaw, policyRaw, cek, 2000000000);
  assert.deepEqual(v2.encodeV2Receipt(receipt), receiptRaw);
  const managed = v2.verifyV2ManagedCertificate(bytes("managed_certificate"), policyRaw, 2000000000);
  assert.deepEqual(v2.encodeV2ManagedCertificate(managed), bytes("managed_certificate"));
  assert.throws(() => v2.verifyV2Receipt(receiptRaw, envelopeRaw, policyRaw, Buffer.alloc(32), 2000000000));
});

test("v2 HTTP client authenticates transport requests and binds policy to its pinned root", async () => {
  const f = fixture(), seen=[];
  const send=async(url, init)=>{
    const path=new URL(url).pathname; seen.push({path,init});
    if(path==="/api/v2/policy")return Response.json({policy:base64(f.rawPolicy)});
    if(path==="/api/v2/mq/retrieve")return Response.json({messages:[]});
    if(path==="/api/v2/mq/ack")return Response.json({ok:true});
    if(path==="/api/v2/handshake/store")return Response.json({ok:true,frame_id:v2.v2Hash(Buffer.from(JSON.parse(init.body).frame,"base64"))});
    if(path==="/api/v2/handshake/retrieve")return Response.json({frames:[]});
    if(path==="/api/v2/handshake/ack")return Response.json({ok:true});
    throw new Error(`unexpected ${path}`);
  };
  const client=new http.V2HTTPClient("http://fixture.local/",f.urn,f.sender.privateKey,send);
  const fetched=await client.fetchPolicy(edRaw(f.root.privateKey),f.policy.platform_id,7);
  assert.deepEqual(fetched.raw,f.rawPolicy);
  await assert.rejects(client.fetchPolicy(edRaw(f.root.privateKey),f.policy.platform_id,8),/rollback/);
  await assert.rejects(client.fetchPolicy(edRaw(crypto.generateKeyPairSync("ed25519").privateKey),f.policy.platform_id),/signature/);
  assert.deepEqual(await client.retrieveMessages(),[]);
  await client.ackMessages(["m1","m1"]);
  const unsigned={version:2,type:"finished",session_id:"s1",sender_urn:f.urn,
    recipient_urn:"urn:agent-comm:agent:recipient",payload:base64(Buffer.alloc(32,1))};
  const frame=v2.encodeV2Handshake({...unsigned,signature:signJSON("agent-comm-v2-handshake\0",unsigned,f.sender.privateKey)});
  assert.equal(await client.storeFrame(frame),v2.v2Hash(frame));
  assert.deepEqual(await client.retrieveFrames(2),[]);
  await client.ackFrames(["f1"]);
  const get=seen.find(item=>item.path==="/api/v2/mq/retrieve");
  const stamp=Buffer.alloc(8);stamp.writeBigUInt64BE(BigInt(get.init.headers["X-Timestamp"]));
  const preimage=Buffer.concat([Buffer.from(`mq-retrieve|${f.urn}|`),stamp]);
  assert.equal(crypto.verify(null,preimage,f.sender.publicKey,Buffer.from(get.init.headers["X-Signature"],"hex")),true);
  const post=seen.find(item=>item.path==="/api/v2/handshake/store");
  const [signature,pub]=post.init.headers.Authorization.slice("Ed25519 ".length).split(":");
  assert.equal(pub,edRaw(f.sender.privateKey).toString("hex"));
  assert.equal(crypto.verify(null,Buffer.from(post.init.body),f.sender.publicKey,Buffer.from(signature,"hex")),true);
  assert.throws(()=>new http.V2HTTPClient("http://fixture.local", "urn:wrong:identity",f.sender.privateKey,send));
});
