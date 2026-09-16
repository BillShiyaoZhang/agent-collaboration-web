import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { readBoundedText, RequestBodyError } from "@/lib/shared/http-input";

const handler = NextAuth(authOptions);

export { handler as GET };

export async function POST(request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  try {
    // NextAuth ignores path segments beyond action/provider. Reject these aliases
    // so credential POSTs cannot bypass a proxy limit on the canonical endpoint.
    if ((await context.params).nextauth.length > 2) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // NextAuth otherwise buffers an unbounded JSON or form body before authorize.
    const body = await readBoundedText(request, 16384);
    return handler(new NextRequest(request.url, { method: "POST", headers: request.headers, body }), context);
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
