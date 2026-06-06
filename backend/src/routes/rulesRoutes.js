import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getEffectiveRules,
  getPlatformRules,
  listCategoryRules,
  listPlatformCategoryRules
} from '../services/platformCategoryRuleService.js';

function stripSensitiveText(value) {
  return String(value)
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]')
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]')
    .replace(/\bnode_modules\b/gi, '[node-modules-removed]');
}

function stripSensitiveData(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password/i.test(key))
      .map(([key, item]) => [key, stripSensitiveData(item)]));
  }
  if (typeof value === 'string') return stripSensitiveText(value);
  return value;
}

function normalizeId(value, fallback) {
  return String(value || fallback).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function createRulesRouter(service = {}) {
  const router = express.Router();
  const rulesService = {
    getEffectiveRules,
    getPlatformRules,
    listCategoryRules,
    listPlatformCategoryRules,
    ...service
  };

  function platformIds() {
    return new Set(rulesService.listPlatformCategoryRules().platforms.map((platform) => platform.platformId));
  }

  router.get('/platforms', asyncHandler(async (_req, res) => {
    const platforms = rulesService.listPlatformCategoryRules().platforms
      .map((platform) => rulesService.getPlatformRules(platform.platformId));
    res.json(stripSensitiveData({ platforms }));
  }));

  router.get('/categories', asyncHandler(async (_req, res) => {
    res.json(stripSensitiveData({ categories: rulesService.listCategoryRules() }));
  }));

  router.get('/effective', asyncHandler(async (req, res) => {
    const platformId = normalizeId(req.query.platformId, 'amazon');
    const categoryId = normalizeId(req.query.categoryId, 'generic_ecommerce');

    if (!platformIds().has(platformId)) {
      const err = new Error(`Unknown platform / 未知平台规则：${platformId}`);
      err.statusCode = 404;
      throw err;
    }

    const effectiveRules = rulesService.getEffectiveRules(platformId, categoryId);
    res.json(stripSensitiveData({ effectiveRules }));
  }));

  return router;
}

export default createRulesRouter();
