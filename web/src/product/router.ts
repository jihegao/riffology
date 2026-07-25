import type { OwnerKind, ProductRoute } from "./types";

const safeSegment = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 160
      && !decoded.includes("/") && !decoded.includes("\\")
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const readProductRoute = (
  location: Pick<Location, "pathname" | "search"> = window.location,
): ProductRoute => {
  if (location.pathname === "/") return Object.freeze({ page: "home" });
  const match = /^\/(models|projects)\/([^/]+)\/?$/u.exec(location.pathname);
  if (!match) return Object.freeze({ page: "not_found" });
  const id = safeSegment(match[2]!);
  if (!id) return Object.freeze({ page: "not_found" });
  const conversationValues = new URLSearchParams(location.search).getAll("conversation");
  if (conversationValues.length > 1) return Object.freeze({ page: "not_found" });
  const conversationId = conversationValues[0] === undefined
    ? undefined
    : safeSegment(conversationValues[0]);
  if (conversationValues[0] !== undefined && !conversationId) {
    return Object.freeze({ page: "not_found" });
  }
  return Object.freeze({
    page: "workspace" as const,
    kind: match[1] === "models" ? "model" as const : "project" as const,
    id,
    ...(conversationId ? { conversationId } : {}),
  });
};

export const workspaceHref = (
  kind: OwnerKind,
  id: string,
  conversationId?: string,
): string => {
  const path = `/${kind === "model" ? "models" : "projects"}/${encodeURIComponent(id)}`;
  return conversationId
    ? `${path}?conversation=${encodeURIComponent(conversationId)}`
    : path;
};

export const navigateProduct = (href: string, replace = false): void => {
  history[replace ? "replaceState" : "pushState"]({}, "", href);
  window.dispatchEvent(new Event("riff:product-navigation"));
};
