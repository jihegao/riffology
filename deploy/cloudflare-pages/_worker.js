const PUBLIC_APP_ORIGIN = "https://riff.gaojihe.cn";
const BACKEND_ORIGIN = "https://riff-demo.gaojihe.cn";

const isBackendRoute = (pathname) =>
  pathname === "/api"
  || pathname.startsWith("/api/")
  || pathname === "/browser"
  || pathname.startsWith("/browser/");

const proxyToBackend = async (request, url) => {
  if (url.origin !== PUBLIC_APP_ORIGIN) {
    return Response.json(
      { error: { code: "public_origin_required", message: "Use the canonical Riff application origin." } },
      { status: 421 },
    );
  }

  const upstreamUrl = new URL(`${url.pathname}${url.search}`, BACKEND_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
  return fetch(upstreamRequest);
};

const serveAsset = async (request, env, url) => {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404
    || request.method !== "GET"
    || !request.headers.get("accept")?.includes("text/html")) {
    return response;
  }

  return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (isBackendRoute(url.pathname)) return await proxyToBackend(request, url);
      return await serveAsset(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({
        message: "riff_pages_request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (isBackendRoute(url.pathname)) {
        return Response.json(
          { error: { code: "upstream_unavailable", message: "The Riff backend is unavailable." } },
          { status: 502 },
        );
      }
      return new Response("Riff is temporarily unavailable.", { status: 503 });
    }
  },
};
