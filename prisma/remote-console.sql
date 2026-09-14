-- Additive migration: legacy domain tables and columns are deliberately untouched.
-- Backup first. Never use prisma db push --accept-data-loss on an existing database.
CREATE TABLE IF NOT EXISTS "User" (
 "id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
 "virtualUrn" TEXT, "virtualEd25519PublicKey" TEXT, "virtualEd25519PrivateKey" TEXT,
 "virtualX25519PublicKey" TEXT, "virtualX25519PrivateKey" TEXT, "virtualKeySalt" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "User_virtualUrn_key" ON "User"("virtualUrn");
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
