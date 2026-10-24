const SHADOWFAX_API_BASE = process.env.SHADOWFAX_API_BASE || 'https://api.shadowfax.in';
const CREATE_ENDPOINT = '/api/v1/orders'; 

function log(level, msg, meta = {}) {
  const entry = { level, ts: new Date().toISOString(), service: 'shadowfax-create', msg, ...meta };
  level === 'error' ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry));
}

async function safeJson(res) {
  try { const text = await res.text(); return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, retries = 2) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const opts = { ...options, signal: controller.signal };
  try {
    const res = await fetch(url, opts);
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    if (retries > 0 && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
      return fetchWithTimeout(url, options, timeoutMs, retries - 1);
    }
    throw err;
  }
}

function normalisePhone(raw) { if (!raw) return ''; const digits = String(raw).replace(/\D/g, ''); return digits.length >= 10 ? digits.slice(-10) : digits; }

function buildPackageDetails(items, fallbackWeightKg = 0.5) {
  let totalQty = 0; let totalWeight = 0;
  for (const it of items || []) {
    const qty = Number(it.qty) || 1; const weight = Number(it.weight) || 0;
    totalQty += qty; totalWeight += qty * (weight || 0);
  }
  if (totalWeight === 0) totalWeight = totalQty * fallbackWeightKg;
  return { weight: Math.max(totalWeight, 0.1), quantity: Math.max(totalQty, 1), length: 20, breadth: 15, height: 10 };
}

function buildShadowfaxPayload({ orderId, customer, items, total, pincode, pickup, isCod = false, codAmount = 0 }) {
  const dropPhone = normalisePhone(customer.phone);
  const pickupPhone = normalisePhone(pickup.phone);
  const pkg = buildPackageDetails(items);
  return {
    client_code: pickup.storeBrandId || '', store_brand_id: pickup.storeBrandId || '', order_id: orderId,
    payment_type: isCod ? 'COD' : 'PPD', collectable_amount: isCod ? Number(codAmount || total || 0) : 0,
    package_details: { weight: pkg.weight, quantity: pkg.quantity, length: pkg.length, breadth: pkg.breadth, height: pkg.height },
    pickup_details: { name: pickup.name || 'Dhenora Warehouse', contact_number: pickupPhone, address: pickup.address || '', lat: pickup.lat ? Number(pickup.lat) : undefined, lng: pickup.lng ? Number(pickup.lng) : undefined },
    drop_details: { name: customer.name || 'Customer', contact_number: dropPhone, address: customer.address || '', pincode: String(pincode || customer.pincode || '').replace(/\D/g, '').slice(0, 6) },
    items: (items || []).map((it) => ({ name: it.name || 'Item', sku: it.productId || '', quantity: Number(it.qty) || 1, price: Number(it.price) || 0 })),
    invoice_value: Number(total) || 0, declared_value: Number(total) || 0,
  };
}

// VERCEL HANDLER
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const correlationId = `sfx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  // Vercel parses the JSON body automatically
  const body = req.body || {};
  const { orderId, customer = {}, items = [], total = 0, pincode = '', shadowfaxConfig = {}, isCod = false, codAmount = 0 } = body;

  const apiKey = shadowfaxConfig.apiKey || process.env.SHADOWFAX_API_KEY;
  const creditsKey = shadowfaxConfig.creditsKey || process.env.SHADOWFAX_CREDITS_KEY;
  const storeBrandId = shadowfaxConfig.storeBrandId || process.env.SHADOWFAX_STORE_BRAND_ID;
  const gstin = shadowfaxConfig.gstin || process.env.SHADOWFAX_GSTIN;
  const registeredPhone = shadowfaxConfig.registeredPhone || process.env.SHADOWFAX_REGISTERED_PHONE;

  if (!apiKey) return res.status(400).json({ status: 'error', message: 'Shadowfax API key not configured' });

  const pickup = {
    name: shadowfaxConfig.pickupName || process.env.SHADOWFAX_PICKUP_NAME || 'Dhenora Warehouse',
    address: shadowfaxConfig.pickupAddress || process.env.SHADOWFAX_PICKUP_ADDRESS || '',
    phone: shadowfaxConfig.pickupPhone || process.env.SHADOWFAX_PICKUP_PHONE || registeredPhone || '',
    lat: shadowfaxConfig.pickupLat || process.env.SHADOWFAX_PICKUP_LAT,
    lng: shadowfaxConfig.pickupLng || process.env.SHADOWFAX_PICKUP_LNG,
    storeBrandId,
  };

  const payload = buildShadowfaxPayload({ orderId, customer, items, total, pincode, pickup, isCod, codAmount });
  payload.credits_key = creditsKey; 
  payload.gstin = gstin; 
  payload.registered_phone = registeredPhone;

  const url = `${SHADOWFAX_API_BASE}${CREATE_ENDPOINT}`;
  const requestOptions = { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }, 
    body: JSON.stringify(payload) 
  };

  let response;
  try { 
    response = await fetchWithTimeout(url, requestOptions); 
  } catch (err) { 
    return res.status(502).json({ status: 'error', message: 'Failed to reach Shadowfax', details: err.message, correlationId }); 
  }

  const data = await safeJson(response);

  if (!response.ok) {
    const message = data.message || data.error || data.description || `Shadowfax returned ${response.status}`;
    return res.status(502).json({ status: 'error', message, details: data, correlationId });
  }

  const awb = data.awb || data.awb_number || data.tracking_id || data.waybill || data.data?.awb || data.data?.awb_number || '';
  const trackingUrl = data.tracking_url || data.trackingUrl || (awb ? `https://track.shadowfax.in/track/${awb}` : '');
  const courier = data.courier || data.courier_name || 'Shadowfax';

  if (!awb) return res.status(502).json({ status: 'error', message: 'Shadowfax did not return an AWB', details: data, correlationId });

  return res.status(200).json({ status: 'success', orderId, awb, courier, trackingUrl, raw: data, correlationId });
}