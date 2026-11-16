/**
 * Outbound Keycloak OAuth calls (token, revoke, userinfo).
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const urlSafety = require('./url-safety');

function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (e) {
    return null;
  }
}

function originAndPath(url) {
  const slash = url.indexOf('/', url.indexOf('://') + 3);
  if (slash === -1) {
    return {origin: url, path: '/'};
  }
  return {origin: url.substring(0, slash), path: url.substring(slash)};
}

function formPost(url, settings, fields) {
  const parts = originAndPath(url);
  const bodyFields = Object.assign({}, fields, {
    client_id: settings.oauthClientId,
  });
  const bodyParts = [];
  Object.keys(bodyFields).forEach(function (key) {
    if (bodyFields[key] != null) {
      bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(bodyFields[key])));
    }
  });
  const connection = new http.Connection(parts.origin);
  connection.basicAuth(settings.oauthClientId, settings.oauthClientSecret);
  connection.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  connection.addHeader('Accept', 'application/json');
  return connection.postSync(parts.path, null, bodyParts.join('&'));
}

function exchangeToken(settings, formFields) {
  const unsafe = urlSafety.validateOutboundSettings(settings, ['keycloakBaseUrl']);
  if (unsafe) {
    return {isSuccess: false, code: 0, body: unsafe};
  }
  return formPost(settings.oauthTokenUrl, settings, formFields);
}

function describeHttpResponse(serviceResponse) {
  if (!serviceResponse) {
    return {status: 'null', error: '', errorDescription: ''};
  }
  const data = parseJsonSafe(serviceResponse);
  return {
    status: serviceResponse.code,
    error: data && data.error ? String(data.error) : '',
    errorDescription: data && data.error_description ? String(data.error_description) : '',
  };
}

function expiresAtFromExpiresIn(expiresIn) {
  const seconds = expiresIn != null ? Number(expiresIn) : null;
  return seconds ? Date.now() + seconds * 1000 - 30 * 1000 : null;
}

function mapTokenResponse(serviceResponse) {
  const httpInfo = describeHttpResponse(serviceResponse);
  if (!serviceResponse || !serviceResponse.isSuccess) {
    const localMessage =
      serviceResponse && serviceResponse.code === 0 && serviceResponse.body
        ? String(serviceResponse.body)
        : '';
    if (localMessage) {
      return {success: false, message: localMessage};
    }
    const detail = httpInfo.errorDescription || httpInfo.error || '';
    return {
      success: false,
      message:
        'Token endpoint returned status ' +
        httpInfo.status +
        (detail ? ': ' + detail : '.'),
    };
  }
  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    return {
      success: false,
      message: 'Token endpoint did not return an access token.',
    };
  }
  return {
    success: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: expiresAtFromExpiresIn(data.expires_in),
  };
}

function tokensFromMappedResponse(mapped) {
  if (!mapped || !mapped.success || !mapped.accessToken) {
    return null;
  }
  return {
    accessToken: mapped.accessToken,
    refreshToken: mapped.refreshToken || null,
    expiresAt: mapped.expiresAt != null ? mapped.expiresAt : null,
  };
}

function publicSessionResponse(tokens) {
  if (!tokens) {
    return {success: true, connected: false};
  }
  return {
    success: true,
    connected: true,
    expiresAt: tokens.expiresAt != null ? tokens.expiresAt : null,
  };
}

function publicTokenResponse(mapped) {
  return {
    success: mapped.success,
    message: mapped.message,
    connected: !!mapped.success,
    expiresAt: mapped.expiresAt != null ? mapped.expiresAt : null,
  };
}

function fetchUserInfo(settings, accessToken) {
  const userInfoUrl = settings.oauthUserInfoUrl;
  if (!userInfoUrl) {
    return {ok: false, message: 'Userinfo endpoint unavailable.'};
  }
  const parts = originAndPath(userInfoUrl);
  try {
    const connection = new http.Connection(parts.origin);
    connection.addHeader('Authorization', 'Bearer ' + accessToken);
    connection.addHeader('Accept', 'application/json');
    const response = connection.getSync(parts.path, null);
    if (!response || !response.isSuccess) {
      return {ok: false, message: 'Userinfo request failed.'};
    }
    const claims = parseJsonSafe(response);
    if (!claims || typeof claims !== 'object') {
      return {ok: false, message: 'Userinfo response was not valid JSON.'};
    }
    return {ok: true, claims: claims};
  } catch (e) {
    return {ok: false, message: 'Userinfo request failed.'};
  }
}

function revokeRefreshToken(settings, refreshToken) {
  const revokeUrl = settings.oauthRevokeUrl;
  if (!revokeUrl || !refreshToken) {
    return {ok: false, message: 'Revocation endpoint unavailable.'};
  }
  try {
    const response = formPost(revokeUrl, settings, {
      token: String(refreshToken),
      token_type_hint: 'refresh_token',
    });
    return {ok: !!(response && (response.isSuccess || response.code === 200 || response.code === 204))};
  } catch (e) {
    return {ok: false, message: 'Revocation request failed.'};
  }
}

function isInvalidGrant(serviceResponse) {
  const data = parseJsonSafe(serviceResponse);
  return !!(data && String(data.error) === 'invalid_grant');
}

exports.parseJsonSafe = parseJsonSafe;
exports.exchangeToken = exchangeToken;
exports.mapTokenResponse = mapTokenResponse;
exports.tokensFromMappedResponse = tokensFromMappedResponse;
exports.publicSessionResponse = publicSessionResponse;
exports.publicTokenResponse = publicTokenResponse;
exports.fetchUserInfo = fetchUserInfo;
exports.revokeRefreshToken = revokeRefreshToken;
exports.isInvalidGrant = isInvalidGrant;
