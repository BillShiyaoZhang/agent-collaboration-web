import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { accountEmailPost, accountEmailTokenSchema } from "@/lib/auth/account-email-http";
const schema = z.object({ token: accountEmailTokenSchema }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, body => accountEmailService.verifyEmail(body.token));
}
