exports.handler = async function(event) {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 302,
      headers: { 'Location': '/?gmail_error=' + encodeURIComponent(error) },
      body: ''
    };
  }

  if (!code) {
    return {
      statusCode: 302,
      headers: { 'Location': '/?gmail_error=no_code' },
      body: ''
    };
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        redirect_uri: process.env.GMAIL_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok || tokens.error) {
      throw new Error(tokens.error || 'Token exchange failed');
    }

    // Get user email address
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + tokens.access_token }
    });
    const userInfo = await userRes.json();

    // Encode tokens in URL to pass back to client
    // In production you'd store in a database — for now pass to client sessionStorage
    const tokenData = encodeURIComponent(JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      email: userInfo.email,
      expires_at: Date.now() + (tokens.expires_in * 1000)
    }));

    return {
      statusCode: 302,
      headers: {
        'Location': '/?gmail_connected=true&token=' + tokenData,
        'Cache-Control': 'no-cache'
      },
      body: ''
    };

  } catch(err) {
    return {
      statusCode: 302,
      headers: { 'Location': '/?gmail_error=' + encodeURIComponent(err.message) },
      body: ''
    };
  }
};
