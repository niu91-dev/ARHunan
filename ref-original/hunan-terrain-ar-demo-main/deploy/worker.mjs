const expiredPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>测试已结束</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;background:#0b1816;color:#d4eee5;font:16px system-ui}h1{font-size:28px}p{color:#91b2a7}</style><h1>本轮测试已结束</h1><p>湖南地形全息扫描 · 请联系项目负责人获取新的测试地址。</p></html>`;

export async function handleRequest(request, env, now = Date.now()) {
  const expiry = Date.parse(env.PREVIEW_EXPIRES_AT);
  const headers = {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
  };
  // Worker runs before EVERY static asset. Fail closed if the deadline is invalid.
  // Uses Cloudflare server time; changing a visitor's clock cannot extend access.
  if (!Number.isFinite(expiry) || now >= expiry) {
    return new Response(request.method === 'HEAD' ? null : expiredPage, {
      status: 410, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  }
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  response.headers.set('X-Preview-Expires-At', env.PREVIEW_EXPIRES_AT);
  return response;
}

export default { fetch: (request, env) => handleRequest(request, env) };
