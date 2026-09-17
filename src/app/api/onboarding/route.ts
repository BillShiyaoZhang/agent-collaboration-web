import { createOnboarding } from "@/lib/control/onboarding";
import { onboardingJson, onboardingError } from "@/lib/control/onboarding-http";
import { readBoundedText } from "@/lib/shared/http-input";

export async function POST(request: Request) {
  try { return onboardingJson(await createOnboarding(await readBoundedText(request, 4096), request.headers.get("authorization")), 201); }
  catch (error) { return onboardingError(error); }
}
