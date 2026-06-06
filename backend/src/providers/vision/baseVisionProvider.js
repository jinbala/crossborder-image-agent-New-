import { createProviderError, rawResponsePreview } from './providerErrors.js';

export class BaseVisionProvider {
  constructor({ provider, model }) {
    this.provider = provider;
    this.model = model;
  }

  success({ startedAt, data, rawResponse, metadata = {} }) {
    return {
      provider: this.provider,
      model: this.model,
      durationMs: Date.now() - startedAt,
      status: 'success',
      error: null,
      data,
      metadata,
      rawResponsePreview: rawResponsePreview(rawResponse)
    };
  }

  failure({ startedAt, code = 'UNKNOWN_ERROR', message, details = {}, rawResponse = '', metadata = {} }) {
    return {
      provider: this.provider,
      model: this.model,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: createProviderError(code, message, details),
      data: null,
      metadata,
      rawResponsePreview: rawResponsePreview(rawResponse)
    };
  }
}
