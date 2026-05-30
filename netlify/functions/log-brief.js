// log-brief.js — logs a generated brief to Supabase briefs table
// Called from app.html after renderBrief() succeeds
// Uses service key (server-side only) to bypass RLS for insert

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
    const { accessCode, userId, userEmail, company, contact, role, meetingType, briefJson } = JSON.parse(event.body);

    // Require either a valid access code OR a logged-in Supabase user
    const hasAccessCode = accessCode && accessCode === process.env.ACCESS_CODE;
    const hasUser = userId && userId.length > 10;

    if (!hasAccessCode && !hasUser) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.log('Supabase env vars missing — skipping log');
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, skipped: true })
      };
    }

    // Insert into briefs table
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/briefs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        user_id: userId || null,
        user_email: userEmail || null,
        company: company || '',
        contact: contact || '',
        role: role || '',
        meeting_type: meetingType || '',
        brief_json: briefJson || {},
        created_at: new Date().toISOString()
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.log('Supabase insert error:', insertRes.status, errText);
      // Soft fail — never break the main flow
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, warning: 'Log failed silently' })
      };
    }

    // Also update/upsert profile to track usage count
    if (userId) {
      await fetch(`${supabaseUrl}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: userId,
          email: userEmail || null,
          briefs_used: 1,
          updated_at: new Date().toISOString()
        })
      }).catch(e => console.log('Profile upsert failed:', e.message));
    }

    console.log(`Brief logged — user: ${userEmail || 'anon'} | company: ${company} | meeting: ${meetingType}`);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true })
    };

  } catch(err) {
    console.log('log-brief error:', err.message);
    // Always soft-fail
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, error: err.message })
    };
  }
};
