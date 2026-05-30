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
    const { accessCode, capabilitiesDeck: deck } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!deck) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ wins: '' })
      };
    }

    const systemPrompt = 'You extract client case studies from sales decks. Return ONLY a valid JSON array, no markdown, no explanation.';

    const userPrompt = (section) => `Find every client case study, success story, and reference win in this deck text. This includes:
- Detailed case study slides (full page per client)
- Summary or overview slides listing multiple clients with brief outcomes
- Tables or grids showing client name + result
- Any slide with client logos alongside metrics or outcomes

For each one return:
- client: the actual client/company name (e.g. "Staples", "Kellanova", "Alegeus") — if anonymous use their industry (e.g. "Retail client", "Healthcare client")
- industry: use ONLY these values: "Retail", "Retail/CPG", "Healthcare", "Financial Services", "Manufacturing", "Technology". For food/beverage/consumer goods companies use "Retail/CPG".
- what: what was implemented — be specific, include technologies used
- challenge: the business problem they faced, in one sentence. If not stated write "Not specified"
- outcome: ALL measurable results — every metric, number, percentage, dollar figure, time saving. If only a brief metric is given on a summary slide, include it exactly as written.

STRICT RULES:
- NEVER include Mastek's own company-level stats as a generic claim
- DO include client-specific results even if brief (e.g. "8x performance" from a summary slide is valid)
- ONLY include entries where a real client engagement happened with at least one result or metric
- outcome MUST contain at least one specific number or measurable result
- Capture EVERY win — summary slides often have 5-10 clients in a table or list, extract ALL of them

Return ONLY a JSON array:
[{"client":"Staples","industry":"Retail","what":"Teradata to Snowflake migration on Azure","challenge":"Legacy warehouse causing slow queries","outcome":"8x performance improvement, $1.5M/year cost saving"},{"client":"Kellanova","industry":"Retail/CPG","what":"Modern data platform on AWS with Snowflake","challenge":"Fragmented data across markets","outcome":"1,300+ datasets ingested, 40% efficiency improvement"}]

DECK TEXT:
${section}`;

    // Strip whitespace noise from extracted deck text before processing
    // Raw PPTX/PDF text is ~60-70% whitespace and repeated headers
    const cleanDeck = deck
      .replace(/[ \t]{3,}/g, '  ')      // collapse long whitespace runs
      .replace(/\n{4,}/g, '\n\n\n')      // collapse blank lines
      .trim();

    const extractPass = async (section) => {
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
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt(section) }]
          })
        });
        const data = await res.json();
        const txt = data.content?.find(b => b.type === 'text')?.text || '';
        const m = txt.match(/\[[\s\S]*?\]/);
        if (m) {
          const cases = JSON.parse(m[0]);
          return cases.filter(c => c.client && c.outcome && /\d/.test(c.outcome));
        }
      } catch(e) {
        console.log('Extract pass error:', e.message);
      }
      return [];
    };

    // Split cleaned deck into two halves with overlap, run in parallel
    const len = cleanDeck.length;
    const mid = Math.floor(len / 2);
    const overlap = Math.floor(len * 0.1); // 10% overlap at boundary
    const firstHalf = cleanDeck.substring(0, mid + overlap);
    const secondHalf = cleanDeck.substring(mid - overlap);

    const [cases1, cases2] = await Promise.all([
      extractPass(firstHalf),
      extractPass(secondHalf)
    ]);

    const allCases = [...cases1, ...cases2];

    // Deduplicate by normalized client name
    const seen = new Set();
    const unique = allCases.filter(c => {
      const key = c.client.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const wins = unique
      .slice(0, 15)
      .map(c => {
        let line = `• ${c.client}${c.industry ? ' (' + c.industry + ')' : ''} · ${c.what}`;
        if (c.challenge && c.challenge !== 'Not specified') line += ` · Challenge: ${c.challenge}`;
        line += ` · Results: ${c.outcome}`;
        return line;
      })
      .join('\n');

    console.log('Extracted wins count:', unique.length);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ wins })
    };

  } catch(err) {
    console.log('extract-wins error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, wins: '' })
    };
  }
};
