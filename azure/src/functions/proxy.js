const { app } = require('@azure/functions');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding' // 🔥 important for streaming too
]);

function buildCorsHeaders(requestedHeaders = '*') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders,
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin'
  };
}

function sanitizeRequestHeaders(originalHeaders) {
  const outgoing = new Headers();

  for (const [key, value] of originalHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith('x-forwarded-')) continue;

    outgoing.set(key, value);
  }

  return outgoing;
}

function sanitizeResponseHeaders(originalHeaders) {
  const outgoing = new Headers();

  for (const [key, value] of originalHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    outgoing.set(key, value);
  }

  return outgoing;
}

app.http('proxy', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'proxy',
  handler: async (request, context) => {
    const requestedHeaders =
      request.headers.get('access-control-request-headers') || '*';

    if (request.method === 'OPTIONS') {
      return {
        status: 204,
        headers: buildCorsHeaders(requestedHeaders)
      };
    }

    const targetUrl = request.query.get('url');

    if (!targetUrl) {
      return {
        status: 400,
        headers: {
          ...buildCorsHeaders(requestedHeaders),
          'Content-Type': 'application/json'
        },
        jsonBody: { error: 'Missing required query parameter: url' }
      };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return {
        status: 400,
        headers: {
          ...buildCorsHeaders(requestedHeaders),
          'Content-Type': 'application/json'
        },
        jsonBody: { error: 'Invalid url query parameter' }
      };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        status: 400,
        headers: {
          ...buildCorsHeaders(requestedHeaders),
          'Content-Type': 'application/json'
        },
        jsonBody: { error: 'Only http and https protocols are supported' }
      };
    }

    const outgoingHeaders = sanitizeRequestHeaders(request.headers);
    let body;

    if (!['GET', 'HEAD'].includes(request.method)) {
      body = await request.arrayBuffer();
    }

    try {
      const upstreamResponse = await fetch(parsedUrl, {
        method: request.method,
        headers: outgoingHeaders,
        body,
        redirect: 'follow'
      });

      const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers);

      // 🔥 still required even for streaming
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');

      for (const [key, value] of Object.entries(buildCorsHeaders(requestedHeaders))) {
        responseHeaders.set(key, value);
      }

      responseHeaders.set('x-cors-proxy-target', parsedUrl.origin);

      return {
        status: upstreamResponse.status,
        headers: Object.fromEntries(responseHeaders.entries()),

        // 🚀 STREAMING RESPONSE
        body: upstreamResponse.body
      };
    } catch (error) {
      context.error('Proxy request failed', error);
      return {
        status: 502,
        headers: {
          ...buildCorsHeaders(requestedHeaders),
          'Content-Type': 'application/json'
        },
        jsonBody: { error: 'Unable to reach upstream URL' }
      };
    }
  }
});