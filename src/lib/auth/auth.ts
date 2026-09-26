import type { NextAuthOptions, Session, User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/shared/db";
import { hashPassword, passwordNeedsUpgrade, validPasswordSize, verifyPassword } from "./password";
export { hashPassword, verifyPassword } from "./password";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials): Promise<User | null> {
        if (typeof credentials?.email !== "string" || !credentials.email || credentials.email.length > 254 || !validPasswordSize(credentials.password)) return null;
        const email = credentials.email.trim();
        // Normalize new addresses without rewriting or merging legacy accounts.
        let user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          const matches = await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE lower("email") = ${email.toLowerCase()} LIMIT 1`;
          if (matches[0]) user = await prisma.user.findUnique({ where: { id: matches[0].id } });
        }
        if (!user || !await verifyPassword(credentials.password, user.passwordHash)) return null;
        // Expose this requirement only to someone who has proven the password.
        if (user.requiresEmailVerification && !user.emailVerifiedAt) throw new Error("EmailNotVerified");
        if (passwordNeedsUpgrade(user.passwordHash)) {
          await prisma.user.updateMany({
            where: { id: user.id, passwordHash: user.passwordHash },
            data: { passwordHash: await hashPassword(credentials.password) },
          });
        }
        return { id: user.id, email: user.email, name: user.email.split("@")[0], sessionVersion: user.sessionVersion };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async jwt({ token, user }) {
      if (user) { token.id = user.id; token.sessionVersion = user.sessionVersion; }
      // Each server-side session checks the persisted generation. Old cookies
      // without a generation survive only until the account's first reset.
      if (typeof token.id !== "string" || token.sessionRevoked === true) return { sessionRevoked: true };
      try {
        const current = await prisma.user.findUnique({
          where: { id: token.id },
          select: { sessionVersion: true, requiresEmailVerification: true, emailVerifiedAt: true },
        });
        const version = token.sessionVersion === undefined ? 0 : token.sessionVersion;
        if (!current || !Number.isInteger(version) || version !== current.sessionVersion
          || (current.requiresEmailVerification && !current.emailVerifiedAt)) return { sessionRevoked: true };
        token.sessionVersion = version;
      } catch {
        // A database outage must not restore a revoked account's access.
        return { sessionRevoked: true };
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sessionRevoked === true || typeof token.id !== "string") {
        // NextAuth v4 handles null at runtime; its callback type excludes null.
        return null as unknown as Session;
      }
      if (session.user) session.user.id = token.id;
      return session;
    },
  },
};
