/** This address is intentionally public and embedded by Next at build time. */
export function publicSupportEmail(value: unknown = process.env.NEXT_PUBLIC_SUPPORT_EMAIL): string {
  if (typeof value !== "string") return "";
  const email = value.trim();
  if (email.length > 254 || !/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email)) return "";
  return email;
}
