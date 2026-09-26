import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { accountEmailAddressSchema, accountEmailPost } from "@/lib/auth/account-email-http";
const schema = z.object({ email: accountEmailAddressSchema, callbackUrl: z.string().max(2048).optional() }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, body => accountEmailService.resendVerification(body.email, body.callbackUrl), { status: 202 });
}
