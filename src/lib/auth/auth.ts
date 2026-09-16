import type { NextAuthOptions, User } from "next-auth";
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
        if (typeof credentials?.email !== "string" || !credentials.email || credentials.email.length > 254 || !validPasswordSize(credentials.password)) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user) {
          return null;
        }

        const isValid = await verifyPassword(credentials.password, user.passwordHash);

        if (!isValid) {
          return null;
        }

        if (passwordNeedsUpgrade(user.passwordHash)) {
          await prisma.user.updateMany({
            where: { id: user.id, passwordHash: user.passwordHash },
            data: { passwordHash: await hashPassword(credentials.password) },
          });
        }

        return {
          id: user.id,
          email: user.email,
          name: user.email.split("@")[0],
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
};
