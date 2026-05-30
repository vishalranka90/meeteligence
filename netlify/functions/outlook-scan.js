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
    const { accessCode, accessToken, refreshToken, company, contact, contactEmail, scanType } = body;

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
        body: JSON.stringify({ error: 'No Outlook access token' })
      };
    }

    // Refresh token if needed
    let token = accessToken;
    if (refreshToken) {
      try {
        const refreshRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.OUTLOOK_CLIENT_ID,
            client_secret: process.env.OUTLOOK_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
            scope: 'openid profile email offline_access Mail.Read Calendars.Read User.Read'
          })
        });
        const refreshData = await refreshRes.json();
        if (refreshData.access_token) token = refreshData.access_token;
      } catch(e) {
        console.log('Outlook token refresh failed:', e.message);
      }
    }

    const type = scanType || 'both';
    const results = {};

    if (type === 'email' || type === 'both') {
      results.email = await scanOutlookEmail(token, company, contact, contactEmail);
    }

    if (type === 'calendar' || type === 'both') {
      results.calendar = await scanOutlookCalendar(token);
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(results)
    };

  } catch(err) {
    console.log('Outlook scan error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

async function scanOutlookEmail(token, company, contact, contactEmail) {
  try {
    let searchQuery = '';
    if (contactEmail) {
      searchQuery = `"${contactEmail}"`;
    } else if (contact) {
      const parts = contact.trim().split(/\s+/);
      searchQuery = `"${parts.join(' ')}"`;
    } else if (company) {
      searchQuery = `"${company}"`;
    }

    if (!searchQuery) return { count: 0, summary: 'No search criteria provided.' };

    const url = `https://graph.microsoft.com/v1.0/me/messages?` +
      `$search=${encodeURIComponent(searchQuery)}&` +
      `$top=8&` +
      `$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview&` +
      `$orderby=receivedDateTime desc`;

    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    const data = await res.json();
    if (!res.ok) {
      console.log('Graph email search failed:', data.error?.message);
      return { count: 0, summary: 'Could not search Outlook emails.' };
    }

    const messages = (data.value || []).slice(0, 6);
    if (messages.length === 0) {
      return { count: 0, summary: 'No previous email conversations found with this contact.' };
    }

    const emailContext = messages.map((m, i) => {
      const from = m.from?.emailAddress;
      const to = (m.toRecipients || []).map(r => r.emailAddress?.address).join(', ');
      const date = m.receivedDateTime ? new Date(m.receivedDateTime).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      }) : 'Unknown date';
      return `Email ${i+1} (${i===0?'MOST RECENT':'older'}):\nFrom: ${from?.name||''} <${from?.address||''}>\nTo: ${to}\nDate: ${date}\nSubject: ${m.subject||'No subject'}\nPreview: ${m.bodyPreview||''}`;
    }).join('\n\n');

    const summaryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_KEY
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: 'You are a meeting intelligence assistant. Summarize email history concisely. Return JSON only. No markdown. Email 1 is most recent.',
        messages: [{
          role: 'user',
          content: `Summarize this Outlook email history with ${contact || company}. Email 1 is MOST RECENT.\n\n${emailContext}\n\nReturn ONLY this JSON:\n{\n  "lastContact": "one sentence about Email 1 — what it was about and when",\n  "keyTopics": "2-3 main topics discussed across all emails",\n  "openItems": "any unresolved action items, or 'None'",\n  "relationshipStatus": "warm or cold or active or stalled",\n  "summary": "2-3 sentences starting with the most recent interaction"\n}`
        }]
      })
    });

    const summaryData = await summaryRes.json();
    const textBlock = summaryData.content?.find(b => b.type === 'text');
    let emailSummary = {};
    try {
      emailSummary = JSON.parse(textBlock?.text?.replace(/```json|```/g, '').trim() || '{}');
    } catch(e) {
      emailSummary = { summary: `Found ${messages.length} Outlook emails but could not summarize.` };
    }

    return { count: messages.length, ...emailSummary };

  } catch(e) {
    console.log('Outlook email scan error:', e.message);
    return { count: 0, summary: 'Outlook email scan failed.' };
  }
}

async function scanOutlookCalendar(token) {
  try {
    let userEmail = '', userDomain = '';
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const me = await meRes.json();
      userEmail = (me.mail || me.userPrincipalName || '').toLowerCase();
      userDomain = userEmail.split('@')[1] || '';
    } catch(e) {}

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weekEnd.setHours(23, 59, 59, 999);

    const url = `https://graph.microsoft.com/v1.0/me/calendarView?` +
      `startDateTime=${encodeURIComponent(todayStart.toISOString())}&` +
      `endDateTime=${encodeURIComponent(weekEnd.toISOString())}&` +
      `$top=20&` +
      `$select=id,subject,start,end,location,attendees,organizer,onlineMeeting,bodyPreview,showAs&` +
      `$orderby=start/dateTime`;

    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Prefer': 'outlook.timezone="UTC"'
      }
    });

    const data = await res.json();
    if (!res.ok) {
      console.log('Graph calendar failed:', data.error?.message);
      return { todayMeetings: [], upcomingMeetings: [], totalCount: 0, userEmail };
    }

    const personalDomains = ['gmail','yahoo','hotmail','outlook','icloud','live','aol','protonmail'];

    const meetings = (data.value || [])
      .filter(e => e.showAs !== 'free')
      .map(event => {
        const startStr = event.start?.dateTime || '';
        const endStr = event.end?.dateTime || '';
        const startDate = new Date(startStr + (startStr.endsWith('Z') ? '' : 'Z'));

        const attendees = (event.attendees || []).map(a => ({
          email: (a.emailAddress?.address || '').toLowerCase(),
          name: a.emailAddress?.name || '',
          self: (a.emailAddress?.address || '').toLowerCase() === userEmail,
          responseStatus: a.status?.response || 'none'
        }));

        const externalAttendees = attendees.filter(a => {
          if (a.self || a.email === userEmail) return false;
          if (!userDomain) return true;
          return (a.email.split('@')[1] || '') !== userDomain;
        });

        const internalAttendees = attendees.filter(a => {
          if (a.self) return false;
          if (!userDomain) return false;
          return (a.email.split('@')[1] || '') === userDomain;
        });

        let primaryContact = externalAttendees.length > 0 ? externalAttendees[0] : null;
        let company = '';

        if (primaryContact) {
          const domain = primaryContact.email.split('@')[1] || '';
          const domainBase = domain.replace(/\.(com|org|net|io|co|in|uk|us|au)$/, '').toLowerCase();
          if (!personalDomains.includes(domainBase)) {
            company = domainBase.replace(/\./g, ' ').split(' ')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          }
          if (!primaryContact.name) {
            const local = primaryContact.email.split('@')[0];
            primaryContact.name = local.replace(/[0-9]/g, '').replace(/[._-]+/g, ' ').trim()
              .split(' ').filter(w => w.length > 1)
              .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || local;
          }
        }

        const title = (event.subject || '').toLowerCase();
        let meetingType = 'discovery';
        if (title.includes('demo')) meetingType = 'demo';
        else if (title.includes('proposal') || title.includes('pitch')) meetingType = 'proposal';
        else if (title.includes('follow') || title.includes('followup')) meetingType = 'followup';
        else if (title.includes('qbr') || title.includes('quarterly')) meetingType = 'qbr';
        else if (title.includes('interview')) meetingType = 'interview';
        else if (title.includes('sync') || title.includes('1:1')) meetingType = 'followup';

        const minsUntil = Math.floor((startDate - now) / 60000);
        const isToday = startDate.toDateString() === now.toDateString();
        const isSoon = minsUntil >= 0 && minsUntil <= 30;
        const isUpcoming = minsUntil > 0;

        const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const dateStr = isToday ? 'Today' : startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        return {
          id: event.id,
          title: event.subject || 'Untitled Meeting',
          start: startStr, end: endStr,
          timeStr, dateStr, isToday, isSoon, isUpcoming, minsUntil,
          primaryContact, externalAttendees, internalAttendees,
          totalAttendees: attendees.length,
          company, meetingType,
          location: event.location?.displayName || '',
          meetLink: event.onlineMeeting?.joinUrl || '',
          description: (event.bodyPreview || '').substring(0, 200),
          isInternal: externalAttendees.length === 0,
          provider: 'outlook'
        };
      })
      .filter(m => m.isUpcoming);

    return {
      userEmail, userDomain,
      todayMeetings: meetings.filter(m => m.isToday),
      upcomingMeetings: meetings.filter(m => !m.isToday),
      totalCount: meetings.length
    };

  } catch(e) {
    console.log('Outlook calendar error:', e.message);
    return { todayMeetings: [], upcomingMeetings: [], totalCount: 0 };
  }
}