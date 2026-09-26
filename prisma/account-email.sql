-- Additive tables. User columns are added conditionally by the migration runner.
CREATE TABLE IF NOT EXISTS "EmailActionToken" (
 "hash" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "purpose" TEXT NOT NULL,
 "sessionVersion" INTEGER NOT NULL, "passwordHash" TEXT, "callbackUrl" TEXT,
 "createdAt" REAL NOT NULL, "expiresAt" REAL NOT NULL, "activeAt" REAL, "consumedAt" REAL,
 FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "EmailActionToken_user_purpose_idx" ON "EmailActionToken"("userId", "purpose");
CREATE INDEX IF NOT EXISTS "EmailActionToken_expiry_idx" ON "EmailActionToken"("expiresAt");
CREATE TABLE IF NOT EXISTS "AuthEmailSend" (
 "id" TEXT NOT NULL PRIMARY KEY, "recipientHash" TEXT NOT NULL, "purpose" TEXT NOT NULL,
 "createdAt" REAL NOT NULL, "status" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "AuthEmailSend_recipient_idx" ON "AuthEmailSend"("recipientHash", "createdAt");
CREATE INDEX IF NOT EXISTS "AuthEmailSend_time_idx" ON "AuthEmailSend"("createdAt");
CREATE TABLE IF NOT EXISTS "AuthEmailBudget" ("day" TEXT NOT NULL PRIMARY KEY, "used" INTEGER NOT NULL DEFAULT 0);
