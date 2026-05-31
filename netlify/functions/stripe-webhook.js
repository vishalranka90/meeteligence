// stripe-webhook.js — handles Stripe webhook events
// Updates Supabase profiles table with plan + subscription details
// Netlify env vars needed: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

// Plan limits — mirrors the pricing table
const PLAN_LIMITS = {
  solo:  { briefs_limit: 30,   model: 'haiku',  history_limit: 10  },
  pro:   { briefs_limit: 100,  model: 'sonnet', history_limit: 9999 },
  team:  { briefs_limit: 9999, model: 'sonnet', history_limit: 9999 },
  free:  { briefs_limit: 3,    model: 'haiku',  history_limit: 5   }
};

exports.handler = async function(event) {
  // Stripe webhooks are always POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!webhookSecret || !stripeKey) {
    console.log('Stripe env vars missing');
    return { statusCode: 500, body: 'Stripe not configured' };
  }

  // Verify Stripe signature
  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  // Manual signature verification (no Stripe SDK)
  let stripeEvent;
  try {
    stripeEvent = await verifyStripeSignature(event.body, sig, webhookSecret);
  } catch(err) {
    console.log('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: 'Invalid signature' };
  }

  console.log('Stripe event:', stripeEvent.type, '| id:', stripeEvent.id);

  try {
    switch(stripeEvent.type) {

      // ── Payment succeeded — activate plan ─────────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        if (session.mode !== 'subscription') break;

        const plan = session.metadata?.plan || 'starter';
        const userId = session.metadata?.user_id;
        const userEmail = session.metadata?.user_email || session.customer_email || '';
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        await upsertProfile(supabaseUrl, serviceKey, {
          id: userId,
          email: userEmail,
          plan,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan_activated_at: new Date().toISOString(),
          briefs_used: 0, // Reset on new plan
          briefs_limit: PLAN_LIMITS[plan]?.briefs_limit || 20,
          model_tier: PLAN_LIMITS[plan]?.model || 'haiku',
          history_limit: PLAN_LIMITS[plan]?.history_limit || 10,
          subscription_status: 'active'
        });

        console.log(`Plan activated — ${plan} | user: ${userEmail} | customer: ${customerId}`);
        break;
      }

      // ── Subscription renewed — reset monthly brief count ──────
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const customerId = invoice.customer;

        // Look up user by Stripe customer ID
        const profile = await fetchProfileByCustomerId(supabaseUrl, serviceKey, customerId);
        if (!profile) {
          console.log('No profile found for customer:', customerId);
          break;
        }

        // Reset usage counter for new billing cycle
        await updateProfile(supabaseUrl, serviceKey, profile.id, {
          briefs_used: 0,
          subscription_status: 'active',
          updated_at: new Date().toISOString()
        });

        console.log(`Monthly reset — customer: ${customerId} | user: ${profile.email}`);
        break;
      }

      // ── Subscription cancelled / payment failed ────────────────
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = stripeEvent.data.object;
        const customerId = obj.customer;

        const profile = await fetchProfileByCustomerId(supabaseUrl, serviceKey, customerId);
        if (!profile) break;

        await updateProfile(supabaseUrl, serviceKey, profile.id, {
          plan: 'free',
          subscription_status: stripeEvent.type === 'invoice.payment_failed' ? 'past_due' : 'cancelled',
          briefs_limit: PLAN_LIMITS.free.briefs_limit,
          model_tier: 'haiku',
          updated_at: new Date().toISOString()
        });

        console.log(`Subscription ${stripeEvent.type} — customer: ${customerId}`);
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };

  } catch(err) {
    console.log('Webhook handler error:', err.message);
    // Return 200 so Stripe doesn't retry — log the error
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, error: err.message })
    };
  }
};

// ── Stripe signature verification (no SDK) ─────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (!timestamp || !signature) throw new Error('Invalid signature format');

  // Check timestamp within 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
    throw new Error('Timestamp too old');
  }

  // Compute HMAC-SHA256
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computed = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed !== signature) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}

// ── Supabase helpers ───────────────────────────────────────────────
async function upsertProfile(supabaseUrl, serviceKey, data) {
  // Remove nullish fields to avoid overwriting good data
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v != null));

  const res = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(clean)
  });

  if (!res.ok) {
    const err = await res.text();
    console.log('upsertProfile failed:', res.status, err);
  }
}

async function updateProfile(supabaseUrl, serviceKey, userId, data) {
  const res = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey
    },
    body: JSON.stringify(data)
  });

  if (!res.ok) {
    const err = await res.text();
    console.log('updateProfile failed:', res.status, err);
  }
}

async function fetchProfileByCustomerId(supabaseUrl, serviceKey, customerId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey
      }
    }
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data[0] || null;
}
