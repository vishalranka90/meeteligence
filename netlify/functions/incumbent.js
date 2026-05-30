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
    const { accessCode, company, offering } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!company) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: false, incumbent: null })
      };
    }

    console.log('Incumbent research for:', company, '| offering:', offering);

    // Two targeted searches run in parallel:
    // 1. Job postings — most reliable signal for actual tech stack in use
    // 2. Vendor announcements / press releases — SI partner and platform deals
    const [jobResult, vendorResult] = await Promise.allSettled([
      searchJobPostings(company, offering),
      searchVendorAnnouncements(company, offering)
    ]);

    const jobSignals = jobResult.status === 'fulfilled' ? jobResult.value : '';
    const vendorSignals = vendorResult.status === 'fulfilled' ? vendorResult.value : '';

    console.log('jobSignals:', jobSignals ? jobSignals.substring(0, 200) : 'none');
    console.log('vendorSignals:', vendorSignals ? vendorSignals.substring(0, 200) : 'none');

    if (!jobSignals && !vendorSignals) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: false, incumbent: null })
      };
    }

    // Synthesize raw signals into structured incumbent intel
    const incumbent = await synthesizeIncumbent(company, offering, jobSignals, vendorSignals);

    if (!incumbent || !incumbent.found) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ found: false, incumbent: null })
      };
    }

    console.log('Incumbent result:', JSON.stringify(incumbent).substring(0, 300));

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ found: true, incumbent })
    };

  } catch(err) {
    console.log('incumbent error:', err.message);
    // Soft fail — never break the main generate flow
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ found: false, incumbent: null, error: err.message })
    };
  }
};

// ── Search 1: Job postings — reveal actual tech stack ────────────
async function searchJobPostings(company, offering) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a sales intelligence analyst. Search for job postings to identify what technology stack, cloud platforms, and consulting partners a company uses. Return plain text bullet points only. No markdown, no bold.',
        messages: [{
          role: 'user',
          content: `Search for recent job postings from ${company} that mention data, analytics, cloud, or technology platforms. Look for: specific tools named (Snowflake, Databricks, AWS, Azure, GCP, Tableau, PowerBI, dbt, Informatica, SAP etc), consulting partner mentions, and system integrator references.

Search query: "${company}" jobs data engineer OR analytics OR cloud platform 2025 2026

Return 3-5 bullet points like:
• [specific finding from job posting — tool name, requirement, or partner mention]
Plain text only, no markdown.`
        }]
      })
    });

    const d = await res.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const clean = txt.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
    return clean.includes('•') ? clean : '';
  } catch(e) {
    console.log('searchJobPostings error:', e.message);
    return '';
  }
}

// ── Search 2: Vendor announcements / press releases ──────────────
async function searchVendorAnnouncements(company, offering) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a sales intelligence analyst. Search for vendor partnership announcements and press releases to identify a company\'s technology partners and system integrators. Return plain text bullet points only. No markdown, no bold.',
        messages: [{
          role: 'user',
          content: `Search for vendor announcements, partnership news, or technology deals involving ${company}. Look for: named SI partners (Accenture, Deloitte, TCS, Infosys, Wipro, Capgemini), cloud platform deals (AWS, Azure, GCP), data platform partnerships (Snowflake, Databricks, Palantir), or any technology vendor press releases mentioning ${company} as a customer.

Search query: "${company}" partner OR selects OR implements OR deploys technology platform 2024 2025 2026

Return 3-5 bullet points like:
• [specific finding — vendor name, announcement, deal type]
Plain text only, no markdown.`
        }]
      })
    });

    const d = await res.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const clean = txt.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
    return clean.includes('•') ? clean : '';
  } catch(e) {
    console.log('searchVendorAnnouncements error:', e.message);
    return '';
  }
}

// ── Synthesize raw signals into structured incumbent object ───────
async function synthesizeIncumbent(company, offering, jobSignals, vendorSignals) {
  try {
    const combinedSignals = [
      jobSignals ? `JOB POSTING SIGNALS:\n${jobSignals}` : '',
      vendorSignals ? `VENDOR ANNOUNCEMENT SIGNALS:\n${vendorSignals}` : ''
    ].filter(Boolean).join('\n\n');

    if (!combinedSignals.trim()) return null;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: 'You are a sales intelligence analyst. Extract structured incumbent technology intelligence from raw signals. Return ONLY valid JSON, no markdown, no explanation.',
        messages: [{
          role: 'user',
          content: `Based on these signals about ${company}, extract their incumbent technology stack and partners relevant to someone selling: ${offering || 'data and technology services'}.

SIGNALS:
${combinedSignals}

Return ONLY this JSON (no markdown):
{
  "found": true,
  "platforms": "specific data/analytics platforms in use e.g. Databricks, Snowflake, Tableau — or empty string if unknown",
  "cloudProvider": "primary cloud provider e.g. AWS, Azure, GCP — or empty string if unknown",
  "siPartners": "named SI or consulting partners e.g. Accenture, Deloitte, TCS — or empty string if unknown",
  "keySignal": "one sentence — the single most important incumbent insight for a salesperson walking into this meeting. Must be specific and sourced from the signals above. e.g. 'Job postings from March 2026 show active Databricks hiring with no data governance tooling mentioned — modernization is in progress but governance gap exists.' If nothing specific found write empty string.",
  "confidence": "high or medium or low — based on how specific and recent the signals are"
}

RULES:
- Only include what is actually evidenced in the signals above. Do not guess or infer beyond what is written.
- If signals are too vague to identify specific tools or partners, set found to false.
- confidence is high only if a specific named tool or partner is clearly confirmed.`
        }]
      })
    });

    const d = await res.json();
    const txt = (d.content || []).find(b => b.type === 'text')?.text || '';
    const clean = txt.replace(/```json|```/g, '').trim();
    const m = clean.match(/\{[\s\S]*?\}/);
    if (!m) return null;

    const parsed = JSON.parse(m[0]);
    // Only return if we actually found something useful
    if (!parsed.found) return null;
    if (!parsed.platforms && !parsed.cloudProvider && !parsed.siPartners && !parsed.keySignal) return null;
    return parsed;

  } catch(e) {
    console.log('synthesizeIncumbent error:', e.message);
    return null;
  }
}
