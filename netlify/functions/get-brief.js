// get-brief.js — fetches a single full brief by ID (for reopening past briefs)
// Verifies the brief belongs to the requesting user

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  try {
    const { accessCode, briefId, userId } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!briefId || !userId) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'briefId and userId required' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    const res = await fetch(
      `${supabaseUrl}/rest/v1/briefs?id=eq.${encodeURIComponent(briefId)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );

    if (!res.ok) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Brief not found' })
      };
    }

    const briefs = await res.json();
    if (!briefs[0]) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Brief not found or access denied' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ brief: briefs[0] })
    };

  } catch(err) {
    console.log('get-brief error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
