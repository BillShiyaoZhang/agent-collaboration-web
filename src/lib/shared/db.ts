import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// Next.js bundles the instrumentation and API routes separately. They still
// share a process, so reuse one SQLite connection pool in production as well.
globalForPrisma.prisma = prisma;
