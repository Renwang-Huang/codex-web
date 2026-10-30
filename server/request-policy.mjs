import { isIP } from "node:net";

const loopback = (address) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

export function requestPolicy({
  publicOrigin = "",
  trustLoopbackProxy = false,
} = {}) {
  const configured = publicOrigin ? new URL(publicOrigin) : null;
  if (
    configured &&
    (configured.protocol !== "https:" ||
      configured.username ||
      configured.password ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash)
  ) {
    throw new Error("PUBLIC_ORIGIN 必须是没有路径和凭据的 HTTPS Origin");
  }
  return (req) => {
    const host = String(req.headers.host || "").toLowerCase();
    const peer = req.socket.remoteAddress;
    const trusted = trustLoopbackProxy && loopback(peer);
    const forwardedTls =
      trusted && req.headers["x-forwarded-proto"] === "https";
    const secure = !!req.socket.encrypted || forwardedTls;
    const localHost =
      /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) &&
      loopback(peer);
    if (configured && host !== configured.host && !localHost) {
      return { error: "访问域名不匹配", status: 421 };
    }
    if (configured && host === configured.host && !secure) {
      return { error: "公网入口必须使用 HTTPS 和可信代理", status: 403 };
    }
    const origin =
      configured && host === configured.host
        ? configured.origin
        : `${secure ? "https" : "http"}://${host}`;
    if (req.headers.origin && req.headers.origin !== origin) {
      return { error: "来源不匹配", status: 403 };
    }
    const candidate = trusted
      ? String(req.headers["x-forwarded-for"] || "")
          .split(",")
          .at(-1)
          .trim()
      : "";
    return {
      secure,
      clientAddress: isIP(candidate) ? candidate : peer,
      origin,
    };
  };
}
