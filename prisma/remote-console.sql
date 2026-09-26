-- Additive migration: legacy domain tables and columns are deliberately untouched.
-- Backup first. Never use prisma db push --accept-data-loss on an existing database.
CREATE TABLE IF NOT EXISTS "User" (
 "id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
 "emailVerifiedAt" DATETIME, "requiresEmailVerification" BOOLEAN NOT NULL DEFAULT false, "sessionVersion" INTEGER NOT NULL DEFAULT 0,
 "virtualUrn" TEXT, "virtualEd25519PublicKey" TEXT, "virtualEd25519PrivateKey" TEXT,
 "virtualX25519PublicKey" TEXT, "virtualX25519PrivateKey" TEXT, "virtualKeySalt" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "User_virtualUrn_key" ON "User"("virtualUrn");
CREATE TABLE IF NOT EXISTS "PlatformPolicyState" (
 "platformId" TEXT NOT NULL PRIMARY KEY, "epoch" INTEGER NOT NULL, "policyHash" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "ManagedConsoleCertificate" (
 "userId" TEXT NOT NULL PRIMARY KEY, "platformId" TEXT NOT NULL, "issuerHash" TEXT NOT NULL,
 "certificate" TEXT NOT NULL, "expiresAt" DATETIME NOT NULL,
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "UserPolicyConsent" (
 "userId" TEXT NOT NULL PRIMARY KEY, "platformId" TEXT NOT NULL,
 "epoch" INTEGER NOT NULL, "policyHash" TEXT NOT NULL, "gatewayKeyId" TEXT NOT NULL,
 "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "UserControlPause" (
 "userId" TEXT NOT NULL PRIMARY KEY, "pausedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Agent" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL,
 "urn" TEXT NOT NULL, "publicKey" TEXT NOT NULL, "platformRegistered" BOOLEAN NOT NULL DEFAULT false,
 "lastActiveAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "Agent_userId_fkey" FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_userId_urn_key" ON "Agent"("userId", "urn");
-- Saving a connection never reserves a public agent identity across accounts.
-- Replace only the legacy index; no table, column, or user data is removed.
DROP INDEX IF EXISTS "Agent_urn_key";
CREATE INDEX IF NOT EXISTS "Agent_userId_idx" ON "Agent"("userId");
CREATE TABLE IF NOT EXISTS "ControlRequest" (
 "id" TEXT NOT NULL PRIMARY KEY, "agentId" TEXT NOT NULL, "consoleUrn" TEXT NOT NULL,
 "method" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "requestEnvelope" TEXT NOT NULL,
 "responseEnvelope" TEXT, "status" TEXT NOT NULL DEFAULT 'pending',
 "deadline" DATETIME NOT NULL, "expiresAt" DATETIME NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ControlRequest_agentId_fkey" FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ControlRequest_agentId_idx" ON "ControlRequest"("agentId");
CREATE INDEX IF NOT EXISTS "ControlRequest_expiresAt_idx" ON "ControlRequest"("expiresAt");

-- Account workspace. Payloads, conversation titles and pending text are encrypted
-- by the application; indexes contain only identifiers and scheduling metadata.
CREATE TABLE IF NOT EXISTS "WorkspaceState" (
 "agentId" TEXT NOT NULL PRIMARY KEY, "activeConversationId" TEXT NOT NULL DEFAULT '',
 "activeSelectedAt" REAL NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'waiting',
 "lastAttemptAt" REAL, "lastSuccessAt" REAL, "nextSyncAt" REAL NOT NULL DEFAULT 0,
 "error" TEXT, "failures" INTEGER NOT NULL DEFAULT 0, "requestId" TEXT,
 "plan" TEXT, "leaseToken" TEXT, "leaseUntil" REAL, "lastWakeAt" REAL NOT NULL DEFAULT 0,
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkspaceState_nextSyncAt_idx" ON "WorkspaceState"("nextSyncAt");
CREATE TABLE IF NOT EXISTS "WorkspaceSnapshot" (
 "agentId" TEXT NOT NULL, "method" TEXT NOT NULL, "recordKey" TEXT NOT NULL DEFAULT '',
 "payload" TEXT NOT NULL, "sourceAt" REAL NOT NULL, "savedAt" REAL NOT NULL, "requestId" TEXT NOT NULL,
 PRIMARY KEY("agentId", "method", "recordKey"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "WorkspaceItem" (
 "agentId" TEXT NOT NULL, "kind" TEXT NOT NULL, "itemId" TEXT NOT NULL,
 "conversationId" TEXT NOT NULL DEFAULT '', "payload" TEXT NOT NULL,
 "sourceAt" REAL NOT NULL, "sortTime" REAL NOT NULL, "status" TEXT NOT NULL DEFAULT '',
 PRIMARY KEY("agentId", "kind", "itemId"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkspaceItem_conversation_idx" ON "WorkspaceItem"("agentId", "kind", "conversationId", "sortTime", "itemId");
CREATE TABLE IF NOT EXISTS "WorkspaceConversation" (
 "agentId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "payload" TEXT NOT NULL,
 "sourceAt" REAL NOT NULL, "updatedAt" REAL NOT NULL,
 PRIMARY KEY("agentId", "conversationId"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkspaceConversation_updatedAt_idx" ON "WorkspaceConversation"("agentId", "updatedAt");
CREATE TABLE IF NOT EXISTS "WorkspaceSubmission" (
 "agentId" TEXT NOT NULL PRIMARY KEY, "requestId" TEXT NOT NULL, "payload" TEXT NOT NULL,
 "createdAt" REAL NOT NULL, "phase" TEXT NOT NULL DEFAULT 'sending',
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve original calls beyond cache expiry; call parameters/results are encrypted.
CREATE TABLE IF NOT EXISTS "WorkspaceOperation" (
 "agentId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "method" TEXT NOT NULL,
 "phase" TEXT NOT NULL DEFAULT 'sending', "payload" TEXT NOT NULL,
 "createdAt" REAL NOT NULL, "updatedAt" REAL NOT NULL,
 PRIMARY KEY("agentId", "requestId"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkspaceOperation_updatedAt_idx" ON "WorkspaceOperation"("agentId", "updatedAt");
CREATE TABLE IF NOT EXISTS "WorkspaceConversationState" (
 "agentId" TEXT NOT NULL, "conversationId" TEXT NOT NULL DEFAULT '',
 "payload" TEXT NOT NULL, "updatedAt" REAL NOT NULL,
 PRIMARY KEY("agentId", "conversationId"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Notification content is encrypted with the same account/connection binding as workspace data.
CREATE TABLE IF NOT EXISTS "WorkspaceNotificationSequence" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE IF NOT EXISTS "WorkspaceNotification" (
 "seq" INTEGER PRIMARY KEY AUTOINCREMENT, "agentId" TEXT NOT NULL, "id" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "state" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "readRevision" INTEGER NOT NULL DEFAULT 0, "remoteRevision" INTEGER NOT NULL DEFAULT 0,
 "sourceAt" REAL NOT NULL, "updatedAt" REAL NOT NULL, "expiresAt" REAL,
 "systemEligible" INTEGER NOT NULL DEFAULT 0, "payload" TEXT NOT NULL,
 UNIQUE("agentId", "id"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkspaceNotification_agent_seq_idx" ON "WorkspaceNotification"("agentId", "seq");
CREATE TABLE IF NOT EXISTS "WorkspaceNotificationBaseline" (
 "agentId" TEXT NOT NULL, "kind" TEXT NOT NULL, "complete" INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY("agentId", "kind"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "WorkspaceNotificationDelivery" (
 "agentId" TEXT NOT NULL, "notificationId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "deviceId" TEXT NOT NULL, "claimedAt" REAL NOT NULL,
 PRIMARY KEY("agentId", "notificationId", "revision", "deviceId"),
 FOREIGN KEY("agentId", "notificationId") REFERENCES "WorkspaceNotification"("agentId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Additive Web Push storage: queue recovery survives process and image replacement.
CREATE TABLE IF NOT EXISTS "WebPushConfig" (
 "id" TEXT PRIMARY KEY, "payload" TEXT NOT NULL, "createdAt" REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS "WebPushSubscription" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
 "endpointHash" TEXT NOT NULL UNIQUE, "binding" TEXT NOT NULL, "payload" TEXT NOT NULL,
 "enabledAt" REAL NOT NULL, "expiresAt" REAL NOT NULL, "visibleUntil" REAL NOT NULL DEFAULT 0,
 "active" INTEGER NOT NULL DEFAULT 1, "lastTestAt" REAL NOT NULL DEFAULT 0, "lastError" TEXT,
 UNIQUE("userId", "deviceId"),
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "WebPushDelivery" (
 "id" TEXT PRIMARY KEY, "subscriptionId" TEXT NOT NULL, "agentId" TEXT NOT NULL,
 "notificationId" TEXT NOT NULL, "revision" INTEGER NOT NULL, "kind" TEXT NOT NULL DEFAULT 'notification',
 "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "claimed" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" REAL NOT NULL, "expiresAt" REAL NOT NULL,
 "leaseToken" TEXT, "leaseUntil" REAL, "updatedAt" REAL NOT NULL, "lastError" TEXT,
 UNIQUE("subscriptionId", "agentId", "notificationId", "revision"),
 FOREIGN KEY("subscriptionId") REFERENCES "WebPushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WebPushDelivery_due_idx" ON "WebPushDelivery"("status", "nextAttemptAt");

-- Short-lived device handoff. Only a hash of the agent's polling secret is stored.
CREATE TABLE IF NOT EXISTS "OnboardingTicket" (
 "id" TEXT PRIMARY KEY, "publicCode" TEXT NOT NULL UNIQUE, "agentUrn" TEXT NOT NULL,
 "agentPublicKey" TEXT NOT NULL, "name" TEXT NOT NULL, "secretHash" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL UNIQUE, "methods" TEXT NOT NULL, "grantExpiresAt" TEXT NOT NULL,
 "ticketExpiresAt" REAL NOT NULL, "userId" TEXT, "agentId" TEXT, "grant" TEXT,
 "signature" TEXT, "consolePublicKey" TEXT, "completedAt" REAL,
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "OnboardingTicket_expiry_idx" ON "OnboardingTicket"("ticketExpiresAt");
CREATE INDEX IF NOT EXISTS "OnboardingTicket_agent_idx" ON "OnboardingTicket"("agentUrn");

-- A deleted account view does not erase or change agent business facts.
CREATE TABLE IF NOT EXISTS "WorkspaceRecordState" (
 "agentId" TEXT NOT NULL, "kind" TEXT NOT NULL, "recordId" TEXT NOT NULL,
 "payload" TEXT NOT NULL, "updatedAt" REAL NOT NULL,
 PRIMARY KEY("agentId", "kind", "recordId"),
 FOREIGN KEY("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
