import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/auth";
import { accountEmailService, AccountEmailError } from "@/lib/auth/account-email";
import { accountEmailFailure, accountEmailHeaders } from "@/lib/auth/account-email-http";
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new AccountEmailError("请先登录。", 401, "UNAUTHORIZED");
    return NextResponse.json(await accountEmailService.account(session.user.id), { headers: accountEmailHeaders });
  } catch (error) { return accountEmailFailure(error); }
}
