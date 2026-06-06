export function createProviderError(code, message, details = {}) {
  return { code, message, details };
}

export function createThrownProviderError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function rawResponsePreview(value) {
  if (value == null) return '';
  return typeof value === 'string'
    ? value.slice(0, 1000)
    : JSON.stringify(value).slice(0, 1000);
}
