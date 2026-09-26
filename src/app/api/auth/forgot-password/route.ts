import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { accountEmailAddressSchema, accountEmailPost } from "@/lib/auth/account-email-http";
const schema = z.object({ email: accountEmailAddressSchema }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, body => accountEmailService.forgotPassword(body.email), { status: 202 });
}
