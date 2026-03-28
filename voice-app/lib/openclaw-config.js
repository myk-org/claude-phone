/**
 * OpenClaw Configuration
 * Loads openclaw.json and provides caller-based routing lookup
 */

var fs = require('fs');
var path = require('path');
var logger = require('./logger');

var CONFIG_PATH = path.join(__dirname, '..', 'config', 'openclaw.json');

var config = null;

try {
  if (fs.existsSync(CONFIG_PATH)) {
    var raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    logger.info('OpenClaw config loaded', {
      users: config.users ? Object.keys(config.users).length : 0
    });
  } else {
    logger.warn('OpenClaw config not found at ' + CONFIG_PATH);
    config = { users: {} };
  }
} catch (err) {
  logger.error('Failed to load OpenClaw config', { error: err.message });
  config = { users: {} };
}

/**
 * Get OpenClaw route for a caller extension
 * @param {string} callerExtension - The caller's extension number
 * @returns {{url: string, token: string, sessionKey: string}|null}
 */
function getRouteForCaller(callerExtension) {
  if (!config || !config.users) return null;

  var userConfig = config.users[callerExtension];
  if (!userConfig || userConfig.backend !== 'openclaw') return null;

  return {
    url: userConfig.url,
    token: userConfig.token,
    sessionKey: userConfig.sessionKey
  };
}

/**
 * Check if any OpenClaw routes are configured
 * @returns {boolean}
 */
function isConfigured() {
  if (!config || !config.users) return false;
  return Object.keys(config.users).length > 0;
}

/**
 * Get the first available OpenClaw route as default
 * Used for outbound calls where the destination may not be in the config
 * @returns {{url: string, token: string, sessionKey: string}|null}
 */
function getDefault() {
  if (!config || !config.users) return null;

  var extensions = Object.keys(config.users);
  for (var i = 0; i < extensions.length; i++) {
    var userConfig = config.users[extensions[i]];
    if (userConfig.backend === 'openclaw') {
      return {
        url: userConfig.url,
        token: userConfig.token,
        sessionKey: userConfig.sessionKey
      };
    }
  }
  return null;
}

module.exports = {
  getRouteForCaller: getRouteForCaller,
  getDefault: getDefault,
  isConfigured: isConfigured
};
