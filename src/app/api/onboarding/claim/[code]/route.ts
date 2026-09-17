import { z } from "zod";
import { previewOnboarding, approveOnboarding } from "@/lib/control/onboarding";
import { onboardingJson, onboardingError, onboardingOwner } from "@/lib/control/onboarding-http";
import { ControlError } from "@/lib/control/control-transport";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { readJsonBody } from "@/lib/shared/http-input";

type Context = { params: Promise<{ code: string }> };
export async function GET(request: Request, { params }: Context) {
  try { return onboardingJson(await previewOnboarding((await params).code, await onboardingOwner())); }
  catch (error) { return onboardingError(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const owner = await onboardingOwner();
    try { requireSameOrigin(request); } catch { throw new ControlError("Forbidden origin", 403); }
    if (!z.object({ confirm: z.literal(true) }).strict().safeParse(await readJsonBody(request, 128)).success) throw new ControlError("Explicit approval required", 400);
    return onboardingJson(await approveOnboarding((await params).code, owner));
  } catch (error) { return onboardingError(error); }
}
