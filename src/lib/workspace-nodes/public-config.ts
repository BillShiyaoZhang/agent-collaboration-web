import "server-only";
import { getDomain } from "tldts";
import { workspacePortalPolicy } from "../auth/workspace-security";

const localHost = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";

// These are browser-facing origins. Never fall back to the internal BFF URL.
export function workspacePublicConfig() {
  const policy = workspacePortalPolicy();
  const control = new URL(process.env.WORKSPACE_GATEWAY_PUBLIC_URL || "");
  const portal = new URL(process.env.NEXTAUTH_URL || "");
  const domain = process.env.WORKSPACE_GATEWAY_DOMAIN || "";
  const root = new URL(`https://${domain}`);
  if (!domain || root.host !== domain || root.pathname !== "/" || root.search || root.hash
      || root.username || root.password || control.username || control.password || control.pathname !== "/"
      || control.search || control.hash || control.origin === portal.origin)
    throw new Error("invalid workspace origins");
  const controlNodeLabel = control.hostname.endsWith("." + root.hostname)
    ? control.hostname.slice(0, -root.hostname.length - 1) : "";
  if (/^[0-9a-f]{24}$/.test(controlNodeLabel)) throw new Error("workspace control host must not be a node host");
  if (policy.mode === "same-site-subdomains" && (portal.hostname === control.hostname
      || portal.hostname === root.hostname || portal.hostname.endsWith("." + root.hostname)
      || control.hostname === root.hostname))
    throw new Error("same-site workspaces require separate portal, control and node hosts");
  if (localHost(control.hostname) && localHost(portal.hostname) && localHost(root.hostname)) {
    if (!["http:", "https:"].includes(control.protocol) || !["http:", "https:"].includes(portal.protocol))
      throw new Error("invalid local workspace origins");
  } else {
    const site = (host: string) => getDomain(host, { allowPrivateDomains: true });
    const controlSite = site(control.hostname), portalSite = site(portal.hostname), nodeSite = site(root.hostname);
    if (control.protocol !== "https:" || portal.protocol !== "https:" || localHost(control.hostname)
        || localHost(portal.hostname) || localHost(root.hostname) || !controlSite || !portalSite || !nodeSite
        || controlSite !== nodeSite)
      throw new Error("workspace origins must be isolated from portal cookies");
    if (policy.mode === "separate-site" && controlSite === portalSite)
      throw new Error("workspace origins must be isolated from portal cookies");
    if (policy.mode === "same-site-subdomains" && controlSite !== portalSite)
      throw new Error("same-site workspaces require the same registrable domain");
  }
  return { gateway_url: control.origin, nodeRoot: root.host };
}

export function validWorkspaceLaunch(url: URL, nodeId: string) {
  const config = workspacePublicConfig();
  const control = new URL(config.gateway_url);
  return url.origin === `${control.protocol}//${nodeId}.${config.nodeRoot}`
    && !url.username && !url.password && url.pathname === "/_ambient/launch"
    && !url.hash && url.searchParams.size === 1 && !!url.searchParams.get("ticket");
}
