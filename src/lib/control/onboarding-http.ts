import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/auth";
import { ControlError } from "./control-transport";
import { RequestBodyError } from "@/lib/shared/http-input";

export const onboardingJson = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Vary": "Cookie, Authorization" },
});
export function onboardingError(error: unknown) {
  const known = error instanceof ControlError || error instanceof RequestBodyError;
  return onboardingJson({ error: known ? error.message : "连接申请暂时无法处理，请重试。" }, known ? error.status : 500);
}
export async function onboardingOwner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("Unauthorized", 401);
  return session.user.id;
}
