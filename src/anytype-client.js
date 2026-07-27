'use strict';

// Cliente mínimo de la API del anytype-cli (misma instancia que usa atvk en
// sinope). El bridge SOLO crea y complementa objetos recién nacidos; nunca
// participa de la reconciliación continua contra Anytype (eso es de atvk).

const { requestJson } = require('./lib/http-json');

class AnytypeClient {
  constructor({ baseUrl, token, version, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.version = version;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const response = await requestJson({
      baseUrl: this.baseUrl,
      path,
      timeoutMs: this.timeoutMs,
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        'anytype-version': this.version,
        ...(options.headers ?? {}),
      },
    });
    return response.data;
  }

  async createObject(spaceId, body) {
    const response = await this.request(
      `spaces/${encodeURIComponent(spaceId)}/objects`,
      { method: 'POST', body },
    );
    return response.object ?? response;
  }

  async getObject(spaceId, objectId) {
    const response = await this.request(
      `spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
    );
    return response.object ?? response;
  }

  async updateObject(spaceId, objectId, patch) {
    const response = await this.request(
      `spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      { method: 'PATCH', body: patch },
    );
    return response.object ?? response;
  }

  async listProperties(spaceId, { limit = 200 } = {}) {
    const properties = [];
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request(
        `spaces/${encodeURIComponent(spaceId)}/properties`,
        { query: { offset, limit } },
      );
      const batch = Array.isArray(response.data) ? response.data : [];
      properties.push(...batch);
      if (!response.pagination?.has_more || batch.length === 0) return properties;
      offset += batch.length;
    }
    throw new Error('Anytype excedió el límite defensivo de paginación de properties.');
  }

  async listTags(spaceId, propertyId, { limit = 200 } = {}) {
    const tags = [];
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request(
        `spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}/tags`,
        { query: { offset, limit } },
      );
      const batch = Array.isArray(response.data) ? response.data : [];
      tags.push(...batch);
      if (!response.pagination?.has_more || batch.length === 0) return tags;
      offset += batch.length;
    }
    throw new Error('Anytype excedió el límite defensivo de paginación de tags.');
  }

  async createTag(spaceId, propertyId, tag) {
    const response = await this.request(
      `spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}/tags`,
      { method: 'POST', body: tag },
    );
    return response.tag ?? response;
  }
}

module.exports = { AnytypeClient };
