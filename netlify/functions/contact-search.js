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
    const { accessCode, contact, company, role } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!contact) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Contact name required' })
      };
    }

    console.log('Contact public search:', contact, 'at', company);

    // Search for the contact's public activity — posts, talks, interviews, articles
    // Use two targeted queries: thought leadership content + general web presence
    const queries = [
      `"${contact}" ${company ? company : ''} linkedin post OR article OR interview OR keynote OR conference 2024 OR 2025`,
      `"${contact}" ${role ? role : ''} ${company ? company : ''} site:linkedin.com OR site:youtube.com OR site:techcrunch.com OR site:forbes.com`
    ].filter(Boolean);

    let publicContent = null;

    for (const query of queries) {
      try {
        // First turn — trigger web search
        const r1 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': process.env.ANTHROPIC_KEY
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            system: 'You are a meeting intelligence assistant. Search for a person\'s recent public content — LinkedIn posts, conference talks, interviews, published articles, podcast appearances. Return ONLY JSON. No markdown.',
            messages: [{
              role: 'user',
              content: `Search for recent public content by ${contact}${company ? ' at ' + company : ''}${role ? ', ' + role : ''}. Look for: LinkedIn posts, conference talks, interviews, articles they wrote or appeared in, podcast episodes. Focus on 2024-2026 content.

Return ONLY this JSON (no markdown):
{
  "found": true or false,
  "recentPost": "one sentence describing their most recent public post or article — topic, platform, approximate date",
  "talkOrInterview": "one sentence describing a recent conference talk, podcast, or interview if found — event name, topic, date",
  "viewpoint": "one sentence capturing a strong opinion, prediction, or recurring theme from their public content",
  "contentUrl": "URL of the most interesting piece of content found, or empty string"
}`
            }]
          })
        });

        const d1 = await r1.json();
        console.log('Contact search stop_reason:', d1.stop_reason, '| types:', (d1.content||[]).map(b=>b.type).join(','));

        // Handle server-side tool use (web_search_20250305 executes automatically)
        // The text block in the SAME response contains the synthesized answer
        let txt = (d1.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

        // Also handle client-side tool_use pattern (older tool type)
        if (!txt && d1.stop_reason === 'tool_use') {
          const toolUse = d1.content?.find(b => b.type === 'tool_use');
          if (toolUse) {
            const r2 = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': process.env.ANTHROPIC_KEY
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                system: 'You are a meeting intelligence assistant. Return ONLY JSON. No markdown.',
                messages: [
                  { role: 'user', content: `Search for recent public content by ${contact}${company ? ' at ' + company : ''}. Return ONLY JSON: {"found":true/false,"recentPost":"...","talkOrInterview":"...","viewpoint":"...","contentUrl":"..."}` },
                  { role: 'assistant', content: d1.content },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: `Search done. Extract public content data for ${contact} and return ONLY the JSON object.` }] }
                ]
              })
            });
            const d2 = await r2.json();
            txt = (d2.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          }
        }

        if (txt) {
          // Strip markdown fences if present
          const clean = txt.replace(/```json|```/g, '').trim();
          const m = clean.match(/\{[\s\S]*?\}/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              if (parsed.found && (parsed.recentPost || parsed.talkOrInterview || parsed.viewpoint)) {
                publicContent = parsed;
                console.log('Contact public content found:', JSON.stringify(parsed).substring(0, 200));
                break;
              }
            } catch(e) {
              console.log('JSON parse failed:', e.message, '| raw:', clean.substring(0, 200));
            }
          }
        }

      } catch(e) {
        console.log('Query error:', e.message);
      }
    }

    if (!publicContent || !publicContent.found) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: false, publicContent: null })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ found: true, publicContent })
    };

  } catch(err) {
    console.log('contact-search error:', err.message);
    return {
      statusCode: 200, // Soft fail — don't break the main generate flow
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ found: false, publicContent: null, error: err.message })
    };
  }
};
