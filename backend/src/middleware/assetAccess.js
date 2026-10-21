import { assertAssetRequest } from '../services/ownershipService.js';
export function assetAccess(req, _res, next) {
  if (!/^\/(?:uploads|outputs)(?:\/|$)/.test(req.path)) return next();
  assertAssetRequest(req.path).then(() => next(), next);
}
