const REGEX_MAX_LENGTH = 200;
const CHANNEL_ID_RE = /^[CDG][A-Z0-9]{8,}$/;

const RULE_KEYS = new Set(['name', 'match', 'target']);
const MATCH_KEYS = new Set(['urlPattern', 'hasFile', 'filetype', 'filenamePattern']);
const TARGET_KEYS = new Set(['channel', 'mainTemplate', 'workerPrompt', 'cardSpec', 'threadBootstrap']);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushUnknownKeys(errors, path, value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function validateRegexField(errors, path, value) {
  if (!hasText(value)) {
    errors.push(`${path}: must be a non-empty string`);
    return;
  }
  if (value.length > REGEX_MAX_LENGTH) {
    errors.push(`${path}: must be at most ${REGEX_MAX_LENGTH} characters`);
  }
}

export function validateDmRoutingRules(rules, path = 'adapters.slack.dmRouting.rules') {
  const errors = [];
  if (!Array.isArray(rules)) {
    errors.push(`${path}: must be an array`);
    return errors;
  }

  rules.forEach((rule, index) => {
    const rulePath = `${path}[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${rulePath}: must be an object`);
      return;
    }
    pushUnknownKeys(errors, rulePath, rule, RULE_KEYS);

    if (!hasText(rule.name)) errors.push(`${rulePath}.name: must be a non-empty string`);

    const match = rule.match;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      errors.push(`${rulePath}.match: must be an object`);
    } else {
      pushUnknownKeys(errors, `${rulePath}.match`, match, MATCH_KEYS);
      const hasUrlPattern = match.urlPattern != null;
      const hasFilenamePattern = match.filenamePattern != null;
      if (hasUrlPattern === hasFilenamePattern) {
        errors.push(`${rulePath}.match: exactly one of urlPattern or filenamePattern is required`);
      }
      if (hasUrlPattern) validateRegexField(errors, `${rulePath}.match.urlPattern`, match.urlPattern);
      if (hasFilenamePattern) validateRegexField(errors, `${rulePath}.match.filenamePattern`, match.filenamePattern);
      if (hasFilenamePattern && match.hasFile !== true) {
        errors.push(`${rulePath}.match.hasFile: must be true when filenamePattern is used`);
      }
      if (match.filetype != null && !hasText(match.filetype)) {
        errors.push(`${rulePath}.match.filetype: must be a non-empty string when present`);
      }
      if (match.hasFile != null && typeof match.hasFile !== 'boolean') {
        errors.push(`${rulePath}.match.hasFile: must be boolean when present`);
      }
    }

    const target = rule.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      errors.push(`${rulePath}.target: must be an object`);
    } else {
      pushUnknownKeys(errors, `${rulePath}.target`, target, TARGET_KEYS);
      if (!hasText(target.channel) || !CHANNEL_ID_RE.test(target.channel)) {
        errors.push(`${rulePath}.target.channel: must be a Slack channel id`);
      }
      if (!hasText(target.mainTemplate)) {
        errors.push(`${rulePath}.target.mainTemplate: must be a non-empty string`);
      }
      if (!hasText(target.workerPrompt)) {
        errors.push(`${rulePath}.target.workerPrompt: must be a non-empty string`);
      }
      if (target.cardSpec != null && !hasText(target.cardSpec)) {
        errors.push(`${rulePath}.target.cardSpec: must be a non-empty string when present`);
      }
      if (target.threadBootstrap != null && !hasText(target.threadBootstrap)) {
        errors.push(`${rulePath}.target.threadBootstrap: must be a non-empty string when present`);
      }
    }
  });

  return errors;
}

export function validateDmRoutingConfig(config) {
  const dmRouting = config?.adapters?.slack?.dmRouting;
  if (!dmRouting) return [];
  if (dmRouting.rules == null) return [];
  return validateDmRoutingRules(dmRouting.rules);
}
