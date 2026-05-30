exports.handler = async function(event) {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI;

  if (!clientId) {
    return { statusCode: 500, body: 'OUTLOOK_CLIENT_ID not configured' };
  }

  const scopes = [
    'openid', 'profile', 'email', 'offline_access',
    'Mail.Read', 'Calendars.Read', 'User.Read'
  ].join(' ');

  const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' +
    'client_id=' + encodeURIComponent(clientId) +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_mode=query' +
    '&scope=' + encodeURIComponent(scopes) +
    '&prompt=select_account';

  return {
    statusCode: 302,
    headers: { 'Location': authUrl, 'Cache-Control': 'no-cache' },
    body: ''
  };
};