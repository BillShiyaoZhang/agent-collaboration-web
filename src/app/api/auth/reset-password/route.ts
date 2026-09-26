import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { accountEmailPost, accountEmailPasswordSchema, accountEmailTokenSchema } from "@/lib/auth/account-email-http";
const schema = z.object({ token: accountEmailTokenSchema, password: accountEmailPasswordSchema }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, body => accountEmailService.resetPassword(body.token, body.password));
}
