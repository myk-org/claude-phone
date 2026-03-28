/**
 * OpenClaw HTTP Bridge
 * HTTP client for OpenClaw gateway (OpenAI-compatible Chat Completions API)
 */

var axios = require('axios');
var logger = require('./logger');

/**
 * Query OpenClaw via OpenAI-compatible Chat Completions API
 * @param {string} transcript - What the user said (voice transcript)
 * @param {Object} options - Connection and session options
 * @param {string} options.url - OpenClaw gateway URL (full URL including path)
 * @param {string} options.token - Bearer token for authentication
 * @param {string} options.sessionKey - Full session key (e.g. "agent:main:openai-user:phone-meni")
 * @returns {Promise<string>} OpenClaw's text response
 */
async function query(transcript, options) {
  options = options || {};
  var url = options.url;
  var token = options.token;
  var sessionKey = options.sessionKey;

  try {
    logger.info('OPENCLAW Sending query to ' + url + '...');
    if (sessionKey) {
      logger.info('OPENCLAW Session: ' + sessionKey);
    }

    var response = await axios.post(
      url,
      {
        model: 'openclaw',
        messages: [{ role: 'user', content: '[VOICE] ' + transcript }]
      },
      {
        timeout: 60000,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'x-openclaw-session-key': sessionKey
        }
      }
    );

    var content = response.data.choices[0].message.content;
    logger.info('OPENCLAW Response received');
    return content;

  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
      logger.error('OPENCLAW Gateway unreachable (' + error.code + ')', { url: url });
      throw new Error("I can't reach my brain right now, try again.");
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      logger.error('OPENCLAW Timeout after 60 seconds', { url: url });
      throw new Error("That took too long, try again.");
    }

    logger.error('OPENCLAW Error: ' + error.message, { url: url });
    throw new Error("Something went wrong, try again.");
  }
}

module.exports = { query };
