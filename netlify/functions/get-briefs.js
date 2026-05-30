// get-briefs.js — fetches past briefs for the logged-in user
// Returns last N briefs based on plan history_limit

const HISTORY_LIMITS = {
  starter: 10,
  pro:     50,
  team:    200,
  free:    5
};

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
    const { accessCode, userId, limit } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!userId) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'User ID required' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ briefs: [] })
      };
    }

    // Fetch user profile to check plan
    let plan = 'free';
    try {
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=plan,briefs_used,briefs_limit&limit=1`,
        { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
      );
      const profiles = await profileRes.json();
      if (profiles[0]) plan = profiles[0].plan || 'free';
    } catch(e) {
      console.log('Profile fetch failed:', e.message);
    }

    const maxBriefs = limit || HISTORY_LIMITS[plan] || 5;

    // Fetch briefs — return metadata only (no brief_json) for list view
    const briefsRes = await fetch(
      `${supabaseUrl}/rest/v1/briefs?user_id=eq.${encodeURIComponent(userId)}&select=id,company,contact,role,meeting_type,created_at&order=created_at.desc&limit=${maxBriefs}`,
      { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );

    if (!briefsRes.ok) {
      const err = await briefsRes.text();
      console.log('Briefs fetch failed:', briefsRes.status, err);
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ briefs: [] })
      };
    }

    const briefs = await briefsRes.json();

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ briefs, plan })
    };

  } catch(err) {
    console.log('get-briefs error:', err.message);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ briefs: [], error: err.message })
    };
  }
};
