import { z } from "zod";
import { pollOnboarding, completeOnboarding } from "@/lib/control/onboarding";
import { onboardingJson, onboardingError } from "@/lib/control/onboarding-http";
import { ControlError } from "@/lib/control/control-transport";
import { readJsonBody } from "@/lib/shared/http-input";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try { return onboardingJson(await pollOnboarding((await params).id, request.headers.get("authorization"))); }
  catch (error) { return onboardingError(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    if (!z.object({ status: z.literal("completed") }).strict().safeParse(await readJsonBody(request, 128)).success) throw new ControlError("Invalid completion", 400);
    return onboardingJson(await completeOnboarding((await params).id, request.headers.get("authorization")));
  } catch (error) { return onboardingError(error); }
}
