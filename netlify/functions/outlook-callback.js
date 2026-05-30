exports.handler = async function(event) {
  const { code, error, error_description } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 302,
      headers: { 'Location': '/app.html?outlook_error=' + encodeURIComponent(error_description || error) },
      body: ''
    };
  }

  if (!code) {
    return {
      statusCode: 302,
      headers: { 'Location': '/app.html?outlook_error=no_code' },
      body: ''
    };
  }

  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: 'openid profile email offline_access Mail.Read Calendars.Read User.Read'
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || tokens.error) {
      throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    }

    // Get user info
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { 'Authorization': 'Bearer ' + tokens.access_token }
    });
    const userInfo = await userRes.json();
    const email = userInfo.mail || userInfo.userPrincipalName || '';

    const tokenData = encodeURIComponent(JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      email,
      displayName: userInfo.displayName || '',
      expires_at: Date.now() + (tokens.expires_in * 1000),
      provider: 'outlook'
    }));

    return {
      statusCode: 302,
      headers: {
        'Location': '/app.html?outlook_connected=true&outlook_token=' + tokenData,
        'Cache-Control': 'no-cache'
      },
      body: ''
    };

  } catch(err) {
    return {
      statusCode: 302,
      headers: { 'Location': '/app.html?outlook_error=' + encodeURIComponent(err.message) },
      body: ''
    };
  }
};