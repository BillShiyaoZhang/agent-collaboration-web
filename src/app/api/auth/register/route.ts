import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/shared/db";
import { hashPassword } from "@/lib/auth/auth";
import { MAX_PASSWORD_BYTES, validPasswordSize } from "@/lib/auth/password";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";

const registerSchema = z.object({
  email: z.string().max(254).email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters")
    .refine(validPasswordSize, `Password must be at most ${MAX_PASSWORD_BYTES} UTF-8 bytes`),
});

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 16384);
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { email, password } = parsed.data;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User with this email already exists" },
        { status: 409 }
      );
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "User with this email already exists" }, { status: 409 });
    }
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
