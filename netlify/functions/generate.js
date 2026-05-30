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
    const { accessCode, company, contact, role, meeting, offering, context, qbrContext, linkedinData, emailHistory, webResearch, capabilitiesDeck, referenceWins, contactPublicContent, incumbentData, _verify } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (_verify) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true })
      };
    }

    // ── Case study extraction ──────────────────────────────────────
    if (JSON.parse(event.body)._extractWins) {
      const deck = capabilitiesDeck || '';
      if (!deck) return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ wins: '' }) };

      const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_KEY },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: 'You extract client case studies from sales decks. Return ONLY a valid JSON array, no markdown, no explanation.',
          messages: [{ role: 'user', content: `Find every client case study and reference win in this deck. For each return: client name, industry (use only: Retail, Retail/CPG, Healthcare, Financial Services, Manufacturing, Technology), what was implemented, challenge faced, and all outcome metrics with numbers. Be liberal — include anything with a client name and a number. Return ONLY JSON array:\n[{"client":"Staples","industry":"Retail","what":"Teradata to Snowflake migration","challenge":"Legacy costs","outcome":"8x performance, $1.5M/year saving"}]\n\nDECK TEXT:\n${deck.substring(0, 40000)}` }]
        })
      });

      const extractData = await extractRes.json();
      const txt = extractData.content?.find(b => b.type === 'text')?.text || '';
      const m = txt.match(/\[[\s\S]*?\]/);
      let wins = '';
      if (m) {
        try {
          const cases = JSON.parse(m[0]).filter(c => c.client && c.outcome && /\d/.test(c.outcome));
          wins = cases.map(c => {
            let line = `• ${c.client}${c.industry ? ' (' + c.industry + ')' : ''} · ${c.what || ''}`;
            if (c.challenge && c.challenge !== 'Not specified') line += ` · Challenge: ${c.challenge}`;
            line += ` · Results: ${c.outcome}`;
            return line;
          }).join('\n');
        } catch(e) { wins = ''; }
      }
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ wins }) };
    }

    // Parse email history
    let emailCtx = null;
    if (emailHistory) {
      try { emailCtx = JSON.parse(emailHistory); } catch(e) {}
    }

    const emailSection = emailCtx ? `
EMAIL HISTORY (${emailCtx.emailCount} emails found):
- Last contact: ${emailCtx.lastContact}
- Topics discussed: ${emailCtx.keyTopics}
- Open items: ${emailCtx.openItems}
- Relationship status: ${emailCtx.relationshipStatus}
- Summary: ${emailCtx.summary}
` : 'No email history available.';

    // Web research context
    const hasNews = webResearch && webResearch.recentNews && webResearch.recentNews.trim().length > 10 && webResearch.recentNews.includes('•');
    console.log('webResearch received:', webResearch ? 'yes' : 'no');
    console.log('hasNews:', hasNews);
    if (webResearch) {
      console.log('recentNews length:', (webResearch.recentNews || '').length);
      console.log('recentNews preview:', (webResearch.recentNews || '').substring(0, 300));
    }

    const hasCompanyFacts = webResearch && webResearch.companyFacts && webResearch.companyFacts.trim().length > 10;

    // Build clearly labelled blocks
    // Cap news only — companyFacts is already summarised bullets, keep in full
    const newsText = hasNews ? webResearch.recentNews.substring(0, 1200) : '';

    const companyFactsBlock = hasCompanyFacts
      ? `=== COMPANY INTEL ===\n${webResearch.companyFacts}\n=== END ===`
      : '=== COMPANY INTEL: not available — use training knowledge ===';

    const newsBlock = newsText
      ? `=== NEWS ===\n${newsText}\n=== END ===`
      : '=== NEWS: none found ===';

    // Capabilities deck — plain text extracted from PDF/PPTX client-side
    const hasDeck = capabilitiesDeck && typeof capabilitiesDeck === 'string' && capabilitiesDeck.length > 50;
    const deckBlock = hasDeck
      ? `=== OUR CAPABILITIES DECK (this is the salesperson's OWN company's offering — not a competitor) ===\n${capabilitiesDeck.substring(0, 30000)}\n=== END ===`
      : '=== CAPABILITIES DECK: Not provided ===';
    const deckNote = hasDeck
      ? 'The CAPABILITIES DECK above belongs to the salesperson\'s OWN company — these are OUR products, services, and differentiators. Never treat the company or tools named in the deck as competitors. Use specific product names, features, and use cases from the deck when writing "Our Angle" and "Questions to Ask". In "Watch Outs", name actual third-party competitors the prospect likely uses — not anything from our deck.'
      : '';

    // Reference wins
    const hasWins = referenceWins && referenceWins.trim().length > 20;
    const winsBlock = hasWins
      ? `=== REFERENCE WINS ===\n${referenceWins.trim().substring(0, 6000)}\n=== END ===`
      : '=== REFERENCE WINS: None provided — write exactly: No relevant wins available for this prospect. ===';

    // Contact public content — posts, talks, interviews found via web search
    let contactPublicBlock = '=== CONTACT PUBLIC CONTENT: None found ===';
    if (contactPublicContent) {
      try {
        const pub = typeof contactPublicContent === 'string' ? JSON.parse(contactPublicContent) : contactPublicContent;
        if (pub && pub.found) {
          const lines = [];
          if (pub.recentPost) lines.push('Recent post/article: ' + pub.recentPost);
          if (pub.talkOrInterview) lines.push('Talk/interview: ' + pub.talkOrInterview);
          if (pub.viewpoint) lines.push('Viewpoint/theme: ' + pub.viewpoint);
          if (pub.contentUrl) lines.push('Source: ' + pub.contentUrl);
          if (lines.length > 0) {
            contactPublicBlock = `=== CONTACT PUBLIC CONTENT ===\n${lines.join('\n')}\n=== END ===`;
          }
        }
      } catch(e) {
        console.log('contactPublicContent parse error:', e.message);
      }
    }

    // Incumbent tech research — job postings + vendor announcements
    let incumbentBlock = '=== INCUMBENT TECH: None found ===';
    if (incumbentData) {
      try {
        const inc = typeof incumbentData === 'string' ? JSON.parse(incumbentData) : incumbentData;
        if (inc && inc.found) {
          const lines = [];
          if (inc.platforms) lines.push('Data/analytics platforms in use: ' + inc.platforms);
          if (inc.cloudProvider) lines.push('Cloud provider: ' + inc.cloudProvider);
          if (inc.siPartners) lines.push('SI/consulting partners: ' + inc.siPartners);
          if (inc.keySignal) lines.push('Key signal: ' + inc.keySignal);
          if (inc.confidence) lines.push('Confidence: ' + inc.confidence);
          if (lines.length > 0) {
            incumbentBlock = `=== INCUMBENT TECH (sourced from job postings and vendor announcements) ===\n${lines.join('\n')}\n=== END ===`;
          }
        }
      } catch(e) {
        console.log('incumbentData parse error:', e.message);
      }
    }

    // ── Meeting-type-specific prompt instructions ──────────────────
    const meetingTypeLabel = {
      discovery: 'Discovery Call',
      demo: 'Product Demo',
      followup: 'Follow-up',
      qbr: 'QBR (Quarterly Business Review)'
    }[meeting] || meeting;

    const ourAngleInstruction = (() => {
      if (meeting === 'demo') return `ourAngle → What to lead with and why. 3 bullets as a sequence:\n• Bullet 1: The specific use case or pain point this demo should open on — name the exact feature or workflow to show first and the business reason.\n• Bullet 2: The "so what" moment — the one output, metric, or screen that will resonate most with this specific role.\n• Bullet 3: The differentiated proof point — a named client win or proprietary capability that no generic vendor can match. BANNED: Mastek company-level stats.`;
      if (meeting === 'followup') return `ourAngle → What was established and what the next move is. 3 bullets:\n• Bullet 1: What was discussed or agreed last time — reference email history if available, or the most likely prior topic given context.\n• Bullet 2: What has changed (new info, urgency, stakeholder) that makes now the right time to move.\n• Bullet 3: The specific ask for this call — a decision, next step, or commitment. Be direct. BANNED: generic "continue the conversation" language.`;
      if (meeting === 'qbr') return `ourAngle → QBR framing — what has been delivered, what is at risk, and what the next phase looks like. 3 bullets:\n• Bullet 1: What has been delivered since the last QBR — anchor to the engagement context provided. Reference milestones, metrics, or open items.\n• Bullet 2: Any risks, gaps, or open items that need exec attention — be honest, not defensive.\n• Bullet 3: The ask for Phase 2 or next commitment — specific scope, timeline, or decision.`;
      return `ourAngle → 3 bullets that build as a sequence. Bullet 1: the pain they already know they have — lead with a specific number, metric, or recent event proving the pain is real now. If INCUMBENT TECH block is available: reference what they are actually running (e.g. "you're mid-build on Databricks but job postings show no governance tooling") — this is far stronger than a generic pain statement. Bullet 2: bridge — connect that pain to a specific capability from our deck that addresses it directly, named specifically. Bullet 3: the differentiated payoff — name a proprietary tool or reference a named client win from REFERENCE WINS as proof. BANNED in bullet 3: Mastek's own company-level stats ("50% timelines", "40% cost savings", "1Bn saved"). Each bullet references company size, industry, or a recent move.`;
    })();

    const topQuestionsInstruction = (() => {
      if (meeting === 'demo') return `topQuestions → Pre-demo qualification questions. 5 bullets:\n• Questions 1-3: qualify the use case before showing anything — what process are they fixing, who else is in the decision, what does success look like.\n• Question 4: anchored to a specific fact about this company or contact — a recent event, metric, or launch.\n• Question 5: the "deal question" — what would make them want to move after the demo? BANNED: "walk me through your stack", generic discovery.`;
      if (meeting === 'followup') return `topQuestions → Questions that move things forward, not restart the conversation. 5 bullets:\n• Questions 1-2: anchored to open items or what was discussed last time — close loops.\n• Questions 3-4: probe for what changed since the last meeting — new stakeholders, urgency, budget shifts.\n• Question 5: direct position question — "where does this sit in your Q[current] priorities?" BANNED: repeating discovery questions.`;
      if (meeting === 'qbr') return `topQuestions → QBR questions focused on relationship health and next phase. 5 bullets:\n• Questions 1-2: honest satisfaction check — what is working, what is not. Leave room for uncomfortable answers.\n• Questions 3-4: future-focused — what is changing in their business or priorities that affects how we work together.\n• Question 5: expansion or renewal question — what would need to be true for them to expand or renew?`;
      return `topQuestions → 5 bullets that build credibility through specificity. Questions 1-4: each tied to a specific fact about this company or contact — a recent event, a metric, a career move, a product launch. If CONTACT PUBLIC CONTENT is available: one question must reference something from their posts, talks, or stated viewpoint. Question 5: as specific as 1-4 — references their background, a tension in their business model, or a visible decision they face. BANNED for Q5: "walk me through your stack", "how are you thinking about your data strategy", generic discovery.`;
    })();

    const qbrBlock = (meeting === 'qbr' && qbrContext && qbrContext.trim().length > 5)
      ? `\n=== CURRENT ENGAGEMENT CONTEXT (QBR) ===\n${qbrContext.trim()}\n=== END ===`
      : (meeting === 'qbr' ? '\n=== CURRENT ENGAGEMENT CONTEXT (QBR): Not provided — infer from email history and additional context ===\n' : '');

    const prompt = `You are a senior sales intelligence analyst preparing a meeting brief for a top-performing enterprise salesperson. Every word must earn its place — specific, actionable, no filler. Return ONLY a valid JSON object.

COMPANY: ${company}
CONTACT: ${contact || 'Unknown'} (${role || 'Unknown role'})
MEETING TYPE: ${meetingTypeLabel}
OFFERING: ${offering}
LINKEDIN DATA: ${linkedinData || 'Not provided'}
EMAIL HISTORY: ${emailSection}
${contactPublicBlock}
${companyFactsBlock}
${newsBlock}
ADDITIONAL CONTEXT: ${context || 'None'}
${qbrBlock}
${incumbentBlock}
${deckBlock}
${deckNote}
${winsBlock}

DATA RULES — strictly follow:
1. companySnapshot → COMPANY INTEL block only. If unavailable use training knowledge. Never use contact LinkedIn data here.
2. recentNews → copy NEWS block bullets exactly as-is. Do not rewrite or summarise. If none write: No recent news.
3. contactInsights → LinkedIn data + CONTACT PUBLIC CONTENT. Be specific about their actual role and background. If public content is available: add a bullet "• Thought leadership: [what they post about, speak about, or their recurring viewpoint — reference the specific content]". This bullet should make the salesperson feel like they know this person personally.
4. ${ourAngleInstruction}
5. ${topQuestionsInstruction}
6. watchouts → real risks for THIS specific meeting. If INCUMBENT TECH block is available: lead with what you actually know — name the specific platforms, cloud provider, or SI partners found in job postings or announcements, and explain why each is a risk (e.g. "Databricks already in use — rip-and-replace is a hard sell; lead with optimization and governance gaps instead"). If no incumbent data: name the most likely third-party competitors based on company size, industry, and role. Never name anything from our own capabilities deck as a competitor. CRITICAL: every bullet must stay in pure risk framing — describe the risk or obstacle only. Never pivot to selling or explain how we address the risk inside a watch out bullet.
7. referenceWins → Always include this field. From the REFERENCE WINS block select the 2-3 most relevant wins using this priority order: (1) Contact FUNCTION first — match the role's core responsibility: a procurement/supply chain role needs vendor/logistics wins; a data engineer needs data platform wins; a CTO needs architecture/platform wins; do NOT show database migration wins to a sales leader or financial wins to an engineer. (2) Company INDUSTRY — retail wins for retail, healthcare for healthcare, financial services for FS. (3) Company SIZE — do not show Fortune 500 proof points to a company under 500 employees, or SMB wins to an enterprise buyer. (4) Only if no function+industry match exists, fall back to strongest metrics. If the block is empty or no wins are relevant write exactly: "No relevant wins available for this prospect." Format each win as: • [Client] ([Industry]) · [what was implemented] · [challenge] · [every result metric — preserve all numbers].
8. openingLine → one sentence that makes them think "this person did their homework". Specific, warm, not salesy. If CONTACT PUBLIC CONTENT is available: strongly prefer to open with a reference to something they recently posted, said in a talk, or publicly advocated for. Reference it naturally without quoting verbatim.

QUALITY BAR — reject anything that could apply to any company or any contact:
✗ "They focus on innovation and customer success"
✗ "How are you thinking about your data strategy?"
✓ "Staples recently pushed into same-day B2B delivery — how is that changing what your sourcing team needs from vendors?"
✓ "As Senior Manager of Sourcing, you're likely being asked to do more with fewer vendors — is that accurate?"

Return ONLY this JSON (no markdown, no backticks):
{
  "companySnapshot": "Exactly 5 separate bullets, each on its own line starting with •. One distinct topic per bullet — do not combine topics. Use this structure:\n• What they do: specific products/services and business model\n• Who they serve: industries, customer types, geographies\n• Scale: revenue, headcount, growth rate if known\n• How they compete: key differentiators, proprietary platforms, moat\n• Strategic moment: one current priority, recent move, or structural shift that matters now",
  "recentNews": "Copy NEWS block bullets exactly. Do not rewrite. If none: No recent news.",
  "contactInsights": "4 bullets with •:\n• Role: [exact title] at [company] — [what this role owns/is responsible for]\n• Background: [2-3 previous roles showing career arc]\n• Education: [school, degree]\n• Their priorities: [specific KPIs, pressures, and goals for someone in this role at this company]",
  "ourAngle": "3 bullets with • following the ${meetingTypeLabel} instructions above.",
  "topQuestions": "5 bullets with • following the ${meetingTypeLabel} instructions above.",
  "watchouts": "2-3 bullets with •. Specific risks only: competitors they likely use, budget timing, internal stakeholders who could block, known objections for this type of company. If email open items exist: ⚠️ Pending: [item]. STAY IN PURE RISK FRAMING — do not mention our offering, do not pivot to selling, do not explain how we address the risk. Each bullet names a threat or obstacle only.",
  "referenceWins": "Always include this field. From the REFERENCE WINS block select the 2-3 most relevant wins using this priority: (1) Contact's FUNCTION — procurement/supply chain needs vendor wins not data migration wins; data engineer needs data platform wins; sales leader needs revenue/GTM wins. (2) Company INDUSTRY match. (3) Company SIZE match. Only fall back to strongest metrics if no function+industry match. If none relevant or block empty write: No relevant wins available for this prospect. Format: • [Client] ([Industry]) · [implementation] · [challenge] · [every metric — preserve all numbers].",
  "openingLine": "One sentence. Reference something specific — a recent company move, a number from their results, something from their LinkedIn background, or an open item from email history. BANNED openers: 'I wanted to', 'Hope you are well', 'I came across', 'I noticed', 'Reaching out', 'Just wanted'. Lead with the insight, not with yourself."
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3500,
        system: 'You are a senior sales intelligence analyst. You write meeting briefs for enterprise salespeople. Every output must be specific, actionable, and tailored — never generic. Respond with valid JSON only. No markdown, no bold, no headers, no backticks. No text before or after the JSON object.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Anthropic API error');
    }

    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No response from AI');

    let brief;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      brief = JSON.parse(cleaned);
    } catch(e) {
      // Try to extract JSON object even if truncated
      const m = textBlock.text.match(/\{[\s\S]*/);
      if (m) {
        let partial = m[0];
        // Close any open strings and the object if truncated
        try {
          brief = JSON.parse(partial);
        } catch(e2) {
          // Count open braces and try to close
          const opens = (partial.match(/\{/g) || []).length;
          const closes = (partial.match(/\}/g) || []).length;
          const needed = opens - closes;
          // Close any open string first
          if ((partial.match(/"/g) || []).length % 2 !== 0) partial += '..."';
          partial += '}'.repeat(Math.max(needed, 1));
          try { brief = JSON.parse(partial); }
          catch(e3) { throw new Error('AI response too long — please try again'); }
        }
      } else {
        throw new Error('Could not parse AI response: ' + textBlock.text.slice(0, 200));
      }
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ brief })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};