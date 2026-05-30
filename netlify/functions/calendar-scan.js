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
    const { accessCode, accessToken, refreshToken } = JSON.parse(event.body);

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
        body: JSON.stringify({ error: 'No access token' })
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
      } catch(e) {
        console.log('Token refresh failed');
      }
    }

    // Get user email for filtering internal attendees
    let userEmail = '';
    let userDomain = '';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const userData = await userRes.json();
      userEmail = (userData.email || '').toLowerCase();
      userDomain = userEmail.split('@')[1] || '';
    } catch(e) {}

    // Time range: today start → 7 days ahead
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weekEnd.setHours(23, 59, 59, 999);

    const timeMin = encodeURIComponent(todayStart.toISOString());
    const timeMax = encodeURIComponent(weekEnd.toISOString());

    // Fetch calendar events
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=20`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );

    const calData = await calRes.json();
    if (!calRes.ok) throw new Error(calData.error?.message || 'Calendar fetch failed');

    const events = calData.items || [];

    // Process each event
    const meetings = events
      .filter(e => e.status !== 'cancelled')
      .map(event => {
        const start = event.start?.dateTime || event.start?.date;
        const end = event.end?.dateTime || event.end?.date;
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Get all attendees — exclude self and organizer
        const organizerEmail = (event.organizer?.email || '').toLowerCase();
        const attendees = (event.attendees || []).map(a => ({
          email: (a.email || '').toLowerCase(),
          name: a.displayName || '',
          self: a.self || false,
          isOrganizer: (a.email || '').toLowerCase() === organizerEmail,
          responseStatus: a.responseStatus || 'needsAction'
        }));

        // Classify attendees — exclude self AND organizer
        const externalAttendees = attendees.filter(a => {
          if (a.self) return false;
          if (a.email === userEmail) return false; // exclude connected account
          if (!userDomain) return true;
          const attendeeDomain = a.email.split('@')[1] || '';
          return attendeeDomain !== userDomain;
        });

        const internalAttendees = attendees.filter(a => {
          if (a.self) return false;
          if (!userDomain) return false;
          const attendeeDomain = a.email.split('@')[1] || '';
          return attendeeDomain === userDomain;
        });

        // Smart primary contact detection
        let primaryContact = null;
        let company = '';
        let meetingType = 'discovery';

        if (externalAttendees.length === 1) {
          // Perfect — one external person
          primaryContact = externalAttendees[0];
        } else if (externalAttendees.length > 1) {
          // Multiple externals — pick first non-generic
          primaryContact = externalAttendees[0];
        } else if (internalAttendees.length > 0) {
          // Internal meeting
          primaryContact = null;
        }

        // Guess company from email domain — skip personal email providers
        const personalDomains = ['gmail','yahoo','hotmail','outlook','icloud','live','aol','protonmail','mail','rediffmail','googlemail'];
        if (primaryContact) {
          const domain = primaryContact.email.split('@')[1] || '';
          const domainBase = domain.replace(/\.(com|org|net|io|co|in|uk|us|au)$/, '').toLowerCase();
          if (!personalDomains.includes(domainBase)) {
            company = domainBase
              .replace(/\./g, ' ')
              .split(' ')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
          } else {
            company = ''; // Leave blank for personal emails
          }

          // If no display name, parse from email local part
          if (!primaryContact.name) {
            const local = primaryContact.email.split('@')[0];
            primaryContact.name = local
              .replace(/[0-9]/g, '')
              .replace(/[._-]+/g, ' ')
              .trim()
              .split(' ')
              .filter(w => w.length > 1)
              .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
              .join(' ') || local;
          }
        }

        // Detect meeting type from title
        const title = (event.summary || '').toLowerCase();
        if (title.includes('demo')) meetingType = 'demo';
        else if (title.includes('proposal') || title.includes('pitch')) meetingType = 'proposal';
        else if (title.includes('follow') || title.includes('followup')) meetingType = 'followup';
        else if (title.includes('qbr') || title.includes('quarterly')) meetingType = 'qbr';
        else if (title.includes('interview')) meetingType = 'interview';
        else if (title.includes('board')) meetingType = 'board';
        else if (title.includes('investor')) meetingType = 'investor';
        else if (title.includes('standup') || title.includes('sync') || title.includes('1:1')) meetingType = 'followup';

        // Is this meeting soon (within 30 mins)?
        const minsUntil = Math.floor((startDate - now) / 60000);
        const isToday = startDate.toDateString() === now.toDateString();
        const isSoon = minsUntil >= 0 && minsUntil <= 30;
        const isUpcoming = minsUntil > 0;
        const isPast = minsUntil < 0 && isToday;

        // Format time
        const timeStr = startDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        const dateStr = isToday ? 'Today' : startDate.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        });

        return {
          id: event.id,
          title: event.summary || 'Untitled Meeting',
          start: start,
          end: end,
          timeStr,
          dateStr,
          isToday,
          isSoon,
          isUpcoming,
          isPast,
          minsUntil,
          primaryContact,
          externalAttendees,
          internalAttendees,
          totalAttendees: attendees.length,
          company,
          meetingType,
          location: event.location || '',
          meetLink: event.hangoutLink || '',
          description: (event.description || '').substring(0, 200),
          isInternal: externalAttendees.length === 0
        };
      })
      .filter(m => m.isUpcoming || (m.isToday && !m.isPast));

    // Group by today vs upcoming
    const todayMeetings = meetings.filter(m => m.isToday);
    const upcomingMeetings = meetings.filter(m => !m.isToday);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        userEmail,
        userDomain,
        todayMeetings,
        upcomingMeetings,
        totalCount: meetings.length
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
