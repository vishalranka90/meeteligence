// create-checkout.js — creates a Stripe Checkout session for a given plan
// Called from the upgrade UI in app.html

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
    const { accessCode, plan, userId, userEmail } = JSON.parse(event.body);

    if (accessCode !== process.env.ACCESS_CODE) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid access code' })
      };
    }

    if (!plan || !['starter', 'pro', 'team'].includes(plan)) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid plan' })
      };
    }

    // Map plan → Stripe Price ID (set these in Netlify env vars after creating products in Stripe)
    const priceIds = {
      starter: process.env.STRIPE_PRICE_STARTER,  // $29/mo
      pro:     process.env.STRIPE_PRICE_PRO,       // $79/mo
      team:    process.env.STRIPE_PRICE_TEAM       // $199/mo
    };

    const priceId = priceIds[plan];
    if (!priceId) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `Stripe price ID not configured for plan: ${plan}` })
      };
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Stripe not configured' })
      };
    }

    const appUrl = process.env.APP_URL || 'https://meeteligence.com';

    // Create Stripe Checkout session via REST API (no SDK needed)
    const params = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appUrl}/app.html?upgrade=success&plan=${plan}`,
      cancel_url: `${appUrl}/app.html?upgrade=cancelled`,
      'metadata[plan]': plan,
      'metadata[user_id]': userId || '',
      'metadata[user_email]': userEmail || '',
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][user_id]': userId || '',
    });

    // Pre-fill email if we have it
    if (userEmail) {
      params.set('customer_email', userEmail);
    }

    const checkoutRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const session = await checkoutRes.json();

    if (!checkoutRes.ok || session.error) {
      console.log('Stripe error:', session.error?.message);
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: session.error?.message || 'Stripe session creation failed' })
      };
    }

    console.log(`Checkout session created — plan: ${plan} | user: ${userEmail} | session: ${session.id}`);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };

  } catch(err) {
    console.log('create-checkout error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
