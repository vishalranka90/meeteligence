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
    const body = JSON.parse(event.body);
    const { accessCode, company, confirmedWebsite } = body;

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    // Step 1: No confirmed website yet — discover and ask user
    if (!confirmedWebsite) {
      const discovered = await discoverCompanyUrls(company, process.env.ANTHROPIC_KEY);
      if (discovered.needsConfirmation) {
        return {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            needsConfirmation: true,
            website: discovered.website,
            linkedinUrl: discovered.linkedinUrl,
            companyName: discovered.companyName
          })
        };
      }
      // Discovery failed — just do news
      return await doFullResearch(company, '', '', process.env.NEWS_API_KEY, process.env.ANTHROPIC_KEY);
    }

    // Step 2: Confirmed website — parse safely
    let website = '', linkedinUrl = '';
    try {
      const parsed = typeof confirmedWebsite === 'string' ? JSON.parse(confirmedWebsite) : confirmedWebsite;
      website = parsed.website || '';
      linkedinUrl = parsed.linkedinUrl || '';
    } catch(e) {
      console.log('Could not parse confirmedWebsite:', e.message);
    }

    return await doFullResearch(company, website, linkedinUrl, process.env.NEWS_API_KEY, process.env.ANTHROPIC_KEY);

  } catch(err) {
    console.log('Research error:', err.message);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ research: { companyFacts: '', recentNews: '' } })
    };
  }
};

// ── UNCHANGED ─────────────────────────────────────────────────────

async function discoverCompanyUrls(company, anthropicKey) {
  try {
    const r1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': anthropicKey
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `Find the official website and LinkedIn company page for "${company}". Return ONLY JSON: {"website":"https://...","linkedinUrl":"https://linkedin.com/company/...","companyName":"exact company name"}`
        }]
      })
    });
    const d1 = await r1.json();
    let urls = { website: '', linkedinUrl: '', companyName: company };

    if (d1.stop_reason === 'tool_use') {
      const toolUse = d1.content?.find(b => b.type === 'tool_use');
      if (toolUse) {
        const r2 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': anthropicKey
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [
              { role: 'user', content: `Find the official website and LinkedIn company page for "${company}". Return ONLY JSON: {"website":"https://...","linkedinUrl":"https://linkedin.com/company/...","companyName":"exact company name"}` },
              { role: 'assistant', content: d1.content },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Search done. Extract website and LinkedIn URLs and return as JSON only.' }] }
            ]
          })
        });
        const d2 = await r2.json();
        const txt = d2.content?.find(b => b.type === 'text')?.text || '';
        const m = txt.match(/\{[\s\S]*?\}/);
        if (m) { try { urls = { ...urls, ...JSON.parse(m[0]) }; } catch(e) {} }
      }
    } else {
      const txt = d1.content?.find(b => b.type === 'text')?.text || '';
      const m = txt.match(/\{[\s\S]*?\}/);
      if (m) { try { urls = { ...urls, ...JSON.parse(m[0]) }; } catch(e) {} }
    }

    console.log('Discovered:', urls);
    if (urls.website) return { needsConfirmation: true, ...urls };
    return { needsConfirmation: false, website: '', linkedinUrl: '', companyName: company };

  } catch(e) {
    console.log('Discovery error:', e.message);
    return { needsConfirmation: false, website: '', linkedinUrl: '', companyName: company };
  }
}

async function scrapeUrl(url) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' }
    });
    if (!res.ok) {
      console.log('Scrape failed:', url, res.status);
      return '';
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) {
      console.log('Skipping non-HTML:', url, ct);
      return '';
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);
    return text;
  } catch(e) {
    console.log('Scrape error:', url, e.message);
    return '';
  }
}

async function synthesizeCompanyIntel(company, websiteText, linkedinText, anthropicKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': anthropicKey
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: 'You are a sales intelligence assistant. Extract factual company information only. Be specific. No fluff.',
        messages: [{
          role: 'user',
          content: `Extract key facts about ${company} from these sources for a salesperson preparing for a meeting.

WEBSITE CONTENT:
${websiteText || 'Not available'}

LINKEDIN CONTENT:
${linkedinText || 'Not available'}

Return 5-7 specific bullets covering:
1. What they actually do — specific products/services, not generic labels
2. Who they serve — industries, customer types, notable clients or partnerships
3. Company scale — size, revenue range, geographic presence if mentioned
4. Competitors or competitive positioning — who they compete with, how they differentiate
5. Tech investments or platform capabilities — what they are building, acquiring or investing in
6. Any strategic priorities or recent initiatives mentioned on site or LinkedIn

Format: bullet points starting with •
Be specific — "Competes with AutoTrader and Cars.com; differentiates on price transparency and AI-powered deal ratings" not "operates in competitive market".
Use only what is in the sources above. If competitive or tech info is not mentioned, use your training knowledge about ${company} to fill those gaps.
Skip generic marketing language.`
        }]
      })
    });
    const data = await res.json();
    return data.content?.find(b => b.type === 'text')?.text || '';
  } catch(e) {
    console.log('Synthesis error:', e.message);
    return '';
  }
}


// ── Web search for company intel ────────────────────────────────
// web_search_20250305 is a SERVER-SIDE tool — Anthropic executes the search
// automatically. It returns server_tool_use + web_search_tool_result blocks
// in the SAME response, then a text block with the answer.
// No multi-turn needed. Just read the text from the single response.
async function fetchWebSearchIntel(company, anthropicKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': anthropicKey
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        system: 'You are a sales intelligence analyst. Search the web and write concise factual bullets from what you find. No markdown, no bold, no headers. Plain text only.',
        messages: [{
          role: 'user',
          content: `Search for recent news about ${company} from 2025 and 2026. Write 4-5 intel bullets covering: store changes, partnerships, leadership, strategy shifts, financials. Format: • [specific fact with numbers/dates]. Plain text only.`
        }]
      })
    });

    const d = await res.json();
    console.log('fetchWebSearchIntel stop_reason:', d.stop_reason);
    console.log('fetchWebSearchIntel content types:', (d.content || []).map(b => b.type).join(', '));

    if (d.error) {
      console.log('fetchWebSearchIntel API error:', d.error.message);
      return null;
    }

    // The text block contains the synthesized answer from search results
    let txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    txt = txt.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
    console.log('webSearchIntel result:', txt.substring(0, 300));
    console.log('webSearchIntel has server_tool_use:', (d.content||[]).some(b => b.type === 'server_tool_use'));

    if (txt && txt.includes('•')) return txt;

    // Web search tool did not fire (end_turn without searching) — use training knowledge
    // This is reliable for well-known companies and costs ~$0.0003
    console.log('Web search did not fire — falling back to training knowledge');
    const fb = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': anthropicKey },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: 'You are a sales intelligence analyst. Write concise factual bullets. No markdown, no bold, no headers. Plain text only.',
        messages: [{ role: 'user', content: `Write 4-5 intel bullets about ${company} for a salesperson. Focus on: recent strategic moves, store/office changes, partnerships, leadership, financials from 2024-2025. Be specific — include numbers, names, dates. Format: • [fact]. Plain text only.` }]
      })
    });
    const fd = await fb.json();
    let ftxt = (fd.content||[]).find(b => b.type === 'text')?.text || '';
    ftxt = ftxt.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
    console.log('Training knowledge result:', ftxt.substring(0, 200));
    if (ftxt && ftxt.includes('•')) return ftxt;
    return null;
  } catch(e) {
    console.log('fetchWebSearchIntel error:', e.message);
    return null;
  }
}



// ── Company Intel: web search only ─────────────────────────────
async function synthesizeNewsIntel(webSearchIntel) {
  if (webSearchIntel) return webSearchIntel;
  return '';
}


async function doFullResearch(company, website, linkedinUrl, newsApiKey, anthropicKey) {
  // Run scraping + web search in parallel
  const [websiteContent, linkedinContent, webSearchResult] = await Promise.allSettled([
    website ? scrapeUrl(website) : Promise.resolve(''),
    linkedinUrl ? scrapeUrl(linkedinUrl) : Promise.resolve(''),
    fetchWebSearchIntel(company, anthropicKey)
  ]);

  const webText = websiteContent.status === 'fulfilled' ? websiteContent.value : '';
  const liText = linkedinContent.status === 'fulfilled' ? linkedinContent.value : '';
  const webSearchIntel = webSearchResult.status === 'fulfilled' ? webSearchResult.value : null;

  console.log('webSearchIntel:', webSearchIntel ? webSearchIntel.substring(0, 200) : 'none');
  console.log('website chars:', webText.length);
  console.log('linkedin chars:', liText.length);

  // Company Snapshot: from website + linkedin scrape
  const companyFacts = (webText || liText)
    ? await synthesizeCompanyIntel(company, webText, liText, anthropicKey)
    : '';

  // Company Intel: web search results only
  const recentNews = webSearchIntel || '';

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      research: {
        companyFacts,
        recentNews
      }
    })
  };
}
