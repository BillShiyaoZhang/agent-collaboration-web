import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { accountEmailAddressSchema, accountEmailPasswordSchema, accountEmailPost } from "@/lib/auth/account-email-http";
const schema = z.object({ email: accountEmailAddressSchema, password: accountEmailPasswordSchema, callbackUrl: z.string().max(2048).optional() }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, body => accountEmailService.register(body.email, body.password, body.callbackUrl), { status: 202 });
}
