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
    const { accessCode, accessToken, refreshToken, company, contact, contactEmail } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!accessToken) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'No Gmail access token' })
      };
    }

    // Refresh token if needed
    let token = accessToken;
    if (refreshToken) {
      try {
        const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.GMAIL_CLIENT_ID,
            client_secret: process.env.GMAIL_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
          })
        });
        const refreshData = await refreshRes.json();
        if (refreshData.access_token) token = refreshData.access_token;
      } catch(e) {}
    }

    // Build search queries — STRICT when we have exact email, loose when manual
    const searchQueries = [];

    if (contactEmail) {
      // EXACT email match only — no fuzzy search
      // This ensures we ONLY get emails from/to this specific person
      searchQueries.push(`from:${contactEmail}`);
      searchQueries.push(`to:${contactEmail}`);
    } else {
      // Manual brief — fuzzy search by name and company
      if (contact) {
        const nameParts = contact.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
        if (lastName) {
          // Full name search is more precise than first name only
          searchQueries.push(`from:"${firstName} ${lastName}" newer_than:365d`);
          searchQueries.push(`"${firstName} ${lastName}" newer_than:365d`);
        } else {
          searchQueries.push(`from:${firstName} newer_than:365d`);
        }
      }
      if (company) {
        const companyCore = company
          .replace(/\s+(inc\.?|llc\.?|ltd\.?|corp\.?|co\.?|company|group|technologies|solutions|services|consulting|partners|associates|international|global)\s*$/gi, '')
          .trim();
        const firstWord = companyCore.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        if (firstWord.length > 3) {
          searchQueries.push(`from:@${firstWord} newer_than:365d`);
        }
      }
    }

    if (searchQueries.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count: 0, threads: [], summary: 'No search criteria provided.' })
      };
    }

    // Run searches and collect unique message IDs
    const allMessageIds = new Set();
    const allMessages = [];

    for (const query of searchQueries) {
      try {
        const searchRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=8`,
          { headers: { 'Authorization': 'Bearer ' + token } }
        );
        const searchData = await searchRes.json();
        if (searchRes.ok && searchData.messages) {
          for (const msg of searchData.messages) {
            if (!allMessageIds.has(msg.id)) {
              allMessageIds.add(msg.id);
              allMessages.push(msg);
            }
          }
        }
      } catch(e) {
        console.log('Search failed:', query, e.message);
      }
    }

    if (allMessages.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          summary: 'No previous email conversations found with this contact.',
          count: 0,
          threads: []
        })
      };
    }

    // Fetch details of up to 6 messages
    const messageDetails = await Promise.all(
      allMessages.slice(0, 6).map(async (msg) => {
        try {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
            { headers: { 'Authorization': 'Bearer ' + token } }
          );
          const msgData = await msgRes.json();
          const headers = {};
          (msgData.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
          return {
            subject: headers['Subject'] || 'No subject',
            from: headers['From'] || 'Unknown',
            to: headers['To'] || '',
            date: headers['Date'] || '',
            snippet: msgData.snippet || ''
          };
        } catch(e) { return null; }
      })
    );

    const validMessages = messageDetails.filter(Boolean);

    // Sort newest first
    validMessages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    // Summarize with Claude
    const emailContext = validMessages.map((m, i) =>
      `Email ${i+1} (${i === 0 ? 'MOST RECENT' : 'older'}):\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\nPreview: ${m.snippet}`
    ).join('\n\n');

    const summaryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: 'You are a meeting intelligence assistant. Summarize email history concisely and accurately. Return JSON only. No markdown. Emails are sorted newest first — Email 1 is the most recent.',
        messages: [{
          role: 'user',
          content: `Summarize this email history with ${contact || company}. Email 1 is the MOST RECENT.

${emailContext}

Return ONLY this JSON:
{
  "lastContact": "one sentence about Email 1 (the most recent interaction) — what it was about and when",
  "keyTopics": "2-3 main topics discussed across all emails",
  "openItems": "any unresolved action items from recent emails, or 'None'",
  "relationshipStatus": "warm or cold or active or stalled",
  "summary": "2-3 sentences. Start with the most recent interaction, then add context from older emails."
}`
        }]
      })
    });

    const summaryData = await summaryRes.json();
    const textBlock = summaryData.content?.find(b => b.type === 'text');
    let emailSummary = {};
    try {
      emailSummary = JSON.parse(textBlock?.text?.replace(/```json|```/g, '').trim() || '{}');
    } catch(e) {
      emailSummary = { summary: 'Found ' + validMessages.length + ' emails but could not summarize.' };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        count: validMessages.length,
        threads: validMessages,
        ...emailSummary
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
