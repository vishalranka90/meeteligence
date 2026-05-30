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
    const { accessCode, name, company } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!name) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Name required' })
      };
    }

    console.log('Searching LinkedIn for:', name, 'at', company);

    // Step 1: Web search to find exact LinkedIn URLs
    let linkedinUrls = [];

    // Try multiple queries from specific to broad
    // Clean company name for better search
    const companyClean = company ? company.replace(/\s+/g, '') : '';
    const companyFirst = company ? company.split(' ')[0] : '';

    const queries = company ? [
      `${name} ${company} linkedin profile`,
      `${name} ${companyFirst} linkedin`,
      `${name} linkedin ${company}`,
      `site:linkedin.com/in ${name} ${companyFirst}`
    ] : [
      `${name} linkedin profile`
    ];

    for (const query of queries) {
      if (linkedinUrls.length > 0) break;

      try {
        const r1 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': process.env.ANTHROPIC_KEY
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{
              role: 'user',
              content: `Search: ${query}\n\nFind LinkedIn profile URLs for ${name}${company ? ' at ' + company : ''}. Return ONLY a JSON array like ["https://linkedin.com/in/handle"] or []`
            }]
          })
        });

        const d1 = await r1.json();
        let urls = [];

        if (d1.stop_reason === 'tool_use') {
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
                max_tokens: 400,
                tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                messages: [
                  { role: 'user', content: `Search: ${query}\n\nFind LinkedIn profile URLs for ${name}${company ? ' at ' + company : ''}. Return ONLY a JSON array like ["https://linkedin.com/in/handle"] or []` },
                  { role: 'assistant', content: d1.content },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Search done. Extract any linkedin.com/in/ URLs and return as JSON array.' }] }
                ]
              })
            });
            const d2 = await r2.json();
            const txt = d2.content?.find(b => b.type === 'text')?.text || '';
            const m = txt.match(/\[[\s\S]*?\]/);
            if (m) { try { urls = JSON.parse(m[0]); } catch(e) {} }
          }
        } else {
          const txt = d1.content?.find(b => b.type === 'text')?.text || '';
          const m = txt.match(/\[[\s\S]*?\]/);
          if (m) { try { urls = JSON.parse(m[0]); } catch(e) {} }
        }

        urls = urls.filter(u => u && u.includes('linkedin.com/in/'));
        if (urls.length > 0) linkedinUrls = urls;
        console.log('Query:', query, '| URLs:', urls.length);

      } catch(e) {
        console.log('Search error:', e.message);
      }
    }

    // Step 2: Fall back to URL guessing if web search found nothing
    if (linkedinUrls.length === 0) {
      const parts = name.trim().toLowerCase().split(/\s+/).filter(p => p.length > 1);
      if (parts.length >= 2) {
        const first = parts[0];
        const last = parts[parts.length - 1];
        linkedinUrls = [
          `https://www.linkedin.com/in/${first}-${last}`,
          `https://www.linkedin.com/in/${last}${first}`,
          `https://www.linkedin.com/in/${last}-${first}`,
          `https://www.linkedin.com/in/${first}${last}`
        ];
      } else if (parts.length === 1) {
        linkedinUrls = [`https://www.linkedin.com/in/${parts[0]}`];
      }
    }

    console.log('Final URLs to enrich:', linkedinUrls);

    // Step 3: Enrich each URL via Enrichlayer
    const candidates = [];
    for (const url of linkedinUrls.slice(0, 4)) {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 6000);

        let res = await fetch(
          'https://enrichlayer.com/api/v2/profile?profile_url=' +
          encodeURIComponent(url) +
          '&use_cache=if-present&skills=include&fallback_to_cache=on-error',
          {
            signal: controller.signal,
            headers: {
              'Authorization': 'Bearer ' + process.env.ENRICHLAYER_KEY,
              'Content-Type': 'application/json'
            }
          }
        );

        let data = await res.json();
        console.log('Enrichlayer full response:', JSON.stringify(data).substring(0, 1000));

        // If profile found but no usable role data, retry with fresh fetch
        const hasRole = (data.occupation || '') || (data.headline || '') ||
          (data.experiences || []).some(e => e.title);
        if (res.ok && data.full_name && !hasRole) {
          console.log('Stale cache — retrying with fresh fetch for:', url);
          const controller2 = new AbortController();
          setTimeout(() => controller2.abort(), 8000);
          const res2 = await fetch(
            'https://enrichlayer.com/api/v2/profile?profile_url=' +
            encodeURIComponent(url) +
            '&use_cache=never&skills=include',
            {
              signal: controller2.signal,
              headers: {
                'Authorization': 'Bearer ' + process.env.ENRICHLAYER_KEY,
                'Content-Type': 'application/json'
              }
            }
          );
          if (res2.ok) {
            const freshData = await res2.json();
            console.log('Fresh fetch — occupation:', freshData.occupation, '| headline:', freshData.headline);
            if (freshData.full_name) data = freshData;
          }
        }

        if (res.ok && data.full_name) {
          const foundName = data.full_name.toLowerCase();
          const nameParts = name.toLowerCase().split(/\s+/);
          const matches = nameParts.some(p => p.length > 2 && foundName.includes(p));

          if (matches) {
            // Sort experiences — current first (no end date = active)
            const sortedExp = (data.experiences || []).sort((a, b) => {
              const aActive = !a.ends_at;
              const bActive = !b.ends_at;
              if (aActive && !bActive) return -1;
              if (!aActive && bActive) return 1;
              return (b.starts_at?.year || 0) - (a.starts_at?.year || 0);
            });

            const currentExp = sortedExp[0];
            const expActive = currentExp && !currentExp.ends_at;

            let currentRole = expActive
              ? currentExp.title + ' at ' + currentExp.company
              : (data.occupation || (currentExp ? currentExp.title + ' at ' + currentExp.company : (data.headline || '')));

            // Enrichlayer has no role data — use web search to find job title directly
            if (!currentRole) {
              try {
                console.log('No role in Enrichlayer — web searching job title for:', data.full_name);
                const sr1 = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_KEY },
                  body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 200,
                    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                    messages: [{ role: 'user', content: `Search for: ${data.full_name} ${company} job title

Return ONLY a JSON object: {"jobTitle": "exact title here"} or {"jobTitle": ""}` }]
                  })
                });
                const sd1 = await sr1.json();
                console.log('Web search stop_reason:', sd1.stop_reason);

                // Handle both tool_use and direct text response
                let roleSearchTxt = '';
                if (sd1.stop_reason === 'tool_use') {
                  const toolUse = sd1.content?.find(b => b.type === 'tool_use');
                  if (toolUse) {
                    const sr2 = await fetch('https://api.anthropic.com/v1/messages', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_KEY },
                      body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 200,
                        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                        messages: [
                          { role: 'user', content: `Search for: ${data.full_name} ${company} job title\n\nReturn ONLY a JSON object: {"jobTitle": "exact title here"} or {"jobTitle": ""}` },
                          { role: 'assistant', content: sd1.content },
                          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: `Search done. Extract ${data.full_name}'s current job title. Return ONLY JSON: {"jobTitle":"exact title"}` }] }
                        ]
                      })
                    });
                    const sd2 = await sr2.json();
                    roleSearchTxt = sd2.content?.find(b => b.type === 'text')?.text || '';
                  }
                } else {
                  // Claude answered directly without searching
                  roleSearchTxt = sd1.content?.find(b => b.type === 'text')?.text || '';
                }
                console.log('Web search raw response:', roleSearchTxt.substring(0, 300));
                const m = roleSearchTxt.match(/\{[\s\S]*?\}/);
                if (m) {
                  try {
                    const parsed = JSON.parse(m[0]);
                    if (parsed.jobTitle && parsed.jobTitle.length < 120) {
                      currentRole = parsed.jobTitle;
                      console.log('Web search found job title:', currentRole);
                    }
                  } catch(e) { console.log('JSON parse failed:', e.message); }
                } else {
                  // No JSON found — try to use the raw text if it looks like a job title
                  const cleaned = roleSearchTxt.replace(/```json|```/g, '').trim();
                  if (cleaned && cleaned.length < 120 && !cleaned.includes('\n')) {
                    currentRole = cleaned;
                    console.log('Raw text job title:', currentRole);
                  }
                }
              } catch(e) {
                console.log('Job title web search failed:', e.message);
              }
            }

            candidates.push({
              full_name: data.full_name,
              occupation: currentRole,
              current_company: currentExp?.company || '',
              city: data.city || '',
              linkedin_url: url,
              experiences: sortedExp.slice(0, 5).map(e => ({
                title: e.title || '',
                company: e.company || '',
                duration: e.date_range || ''
              })),
              education: (data.education || []).slice(0, 2).map(e => ({
                school: e.school || '',
                degree: e.degree_name || ''
              })),
              skills: (data.skills || []).slice(0, 10),
              summary: data.summary || '',
              headline: data.headline || ''
            });

            if (candidates.length >= 3) break;
          }
        }
      } catch(e) {
        console.log('Enrichlayer error:', url, e.message);
      }
    }

    console.log('Candidates:', candidates.length, candidates.map(c => c.full_name + ' | ' + c.occupation));

    if (candidates.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: false, candidates: [] })
      };
    }

    // Auto-select if company matches
    if (company && candidates.length >= 1) {
      const co = company.toLowerCase().split(' ')[0];
      const match = candidates.find(c =>
        c.current_company.toLowerCase().includes(co) ||
        c.occupation.toLowerCase().includes(co)
      );
      if (match) {
        return {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ found: true, autoSelected: true, profile: match, candidates })
        };
      }
    }

    if (candidates.length === 1) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: true, autoSelected: true, profile: candidates[0], candidates })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ found: false, needsPick: true, candidates })
    };

  } catch(err) {
    console.log('Handler error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, found: false, candidates: [] })
    };
  }
};
