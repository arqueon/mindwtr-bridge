'use strict';

class HttpError extends Error {
  constructor(message, { status, method, url, responseBody }) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = responseBody;
  }
}

function joinedUrl(baseUrl, path, query) {
  const normalizedPath = String(path ?? '').replace(/^\/+/, '');
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestJson({
  baseUrl,
  path,
  query,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30_000,
}) {
  const url = joinedUrl(baseUrl, path, query);
  const requestHeaders = {
    accept: 'application/json',
    ...headers,
  };
  const options = {
    method,
    headers: requestHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new HttpError(`${method} ${url.origin}${url.pathname} falló: ${error.message}`, {
      status: null,
      method,
      url: url.toString(),
      responseBody: null,
    });
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const safeBody = typeof data === 'string'
      ? data.slice(0, 4000)
      : JSON.stringify(data).slice(0, 4000);
    throw new HttpError(
      `${method} ${url.origin}${url.pathname} respondió HTTP ${response.status}.`,
      {
        status: response.status,
        method,
        url: url.toString(),
        responseBody: safeBody,
      },
    );
  }

  return {
    data,
    status: response.status,
    headers: response.headers,
  };
}

module.exports = {
  HttpError,
  joinedUrl,
  requestJson,
};
