exports.handler = async function(event, context) {
  // Handle CORS preflight
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

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { accessCode, linkedinUrl } = JSON.parse(event.body);

    // Validate access code
    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!linkedinUrl) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'LinkedIn URL is required' })
      };
    }

    // Call Enrichlayer API
    const apiUrl = 'https://enrichlayer.com/api/v2/profile?profile_url=' + 
      encodeURIComponent(linkedinUrl) + '&use_cache=if-present&skills=include&fallback_to_cache=on-error';

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + process.env.ENRICHLAYER_KEY,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error('Enrichlayer ' + response.status + ': ' + JSON.stringify(data));
    }

    // Extract and return clean profile data
    const profile = {
      full_name: data.full_name || '',
      occupation: data.occupation || '',
      headline: data.headline || '',
      summary: data.summary || '',
      city: data.city || '',
      country: data.country_full_name || '',
      experiences: (data.experiences || []).slice(0, 5).map(e => ({
        title: e.title || '',
        company: e.company || '',
        duration: e.date_range || '',
        description: e.description || ''
      })),
      education: (data.education || []).slice(0, 3).map(e => ({
        school: e.school || '',
        degree: e.degree_name || '',
        field: e.field_of_study || ''
      })),
      skills: (data.skills || []).slice(0, 10)
    };

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ profile })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
