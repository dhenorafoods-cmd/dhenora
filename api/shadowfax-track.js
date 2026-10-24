const SHADOWFAX_API_BASE = process.env.SHADOWFAX_API_BASE || 'https://api.shadowfax.in';
const TRACK_ENDPOINT     = '/api/v1/orders/track'; 
const USE_PATH_PARAM     = false;                  
const AUTH_HEADER_NAME   = 'x-api-key';            
const AUTH_HEADER_FORMAT = 'raw';                  
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_RETRIES        = 2;
const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTO_SYNC_TO_SUPABASE     = true; 
const DEFAULT_API_KEY = process.env.SHADOWFAX_API_KEY;

const STATUS_MAP = {
  'created': { store: 'Packed', label: 'Shipment Created' },
  'manifested': { store: 'Packed', label: 'Manifested' },
  'pickup_pending': { store: 'Packed', label: 'Pickup Pending' },
  'picked_up': { store: 'Shipped', label: 'Picked Up' },
  'out_for_pickup': { store: 'Shipped', label: 'Out for Pickup' },
  'in_transit': { store: 'Shipped', label: 'In Transit' },
  'reached_hub': { store: 'Shipped', label: 'Reached Hub' },
  'at_hub': { store: 'Shipped', label: 'At Hub' },
  'out_for_delivery': { store: 'Shipped', label: 'Out for Delivery' },
  'undelivered': { store: 'Shipped', label: 'Undelivered' },
  'attempted': { store: 'Shipped', label: 'Delivery Attempted' },
  'delivered': { store: 'Delivered', label: 'Delivered' },
  'rto': { store: 'Cancelled', label: 'Return to Origin' },
  'rto_in_transit': { store: 'Shipped', label: 'RTO In Transit' },
  'rto_delivered': { store: 'Cancelled', label: 'RTO Delivered' },
  'cancelled': { store: 'Cancelled', label: 'Cancelled' },
  'lost': { store: 'Cancelled', label: 'Lost' },
  'damaged': { store: 'Cancelled', label: 'Damaged' },
};

function mapStatus(rawStatus) {
  if (!rawStatus) return null;
  const key = String(rawStatus).toLowerCase().trim().replace(/\s+/g, '_');
  return STATUS_MAP[key] || { store: null, label: String(rawStatus) };
}

function log(level, msg, meta = {}) {
  const entry = { level, ts: new Date().toISOString(), service: 'shadowfax-track', msg, ...meta };
  level === 'error' ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry));
}

async function safeJson(res) {
  try { const text = await res.text(); return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES) {
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

function buildAuthHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (AUTH_HEADER_FORMAT === 'bearer') headers[AUTH_HEADER_NAME] = `Bearer ${apiKey}`;
  else if (AUTH_HEADER_FORMAT === 'token') headers[AUTH_HEADER_NAME] = `token ${apiKey}`;
  else headers[AUTH_HEADER_NAME] = apiKey;
  return headers;
}

function normaliseAwb(raw) { return String(raw || '').trim().replace(/\s+/g, ''); }
function normaliseCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') return null;
  return { status: cp.status || cp.status_code || cp.statusCode || '', label: cp.status_label || cp.status_name || cp.message || cp.detail || '', location: cp.location || cp.city || cp.hub || '', timestamp: cp.timestamp || cp.created_at || cp.date || cp.updated_at || '', description: cp.description || cp.remark || cp.note || '' };
}

async function callShadowfaxTrack(awb, apiKey) {
  let url;
  if (USE_PATH_PARAM) url = `${SHADOWFAX_API_BASE}${TRACK_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(awb)}`;
  else { const sep = TRACK_ENDPOINT.includes('?') ? '&' : '?'; url = `${SHADOWFAX_API_BASE}${TRACK_ENDPOINT}${sep}awb=${encodeURIComponent(awb)}`; }
  const response = await fetchWithTimeout(url, { method: 'GET', headers: buildAuthHeaders(apiKey) });
  const data = await safeJson(response);
  if (!response.ok) { const message = data.message || data.error || data.description || `Shadowfax returned ${response.status}`; const err = new Error(message); err.status = response.status; err.body = data; throw err; }
  return data;
}

function normaliseShadowfaxResponse(raw) {
  const payload = raw.data || raw.tracking || raw.shipment || raw;
  const rawStatus = payload.status || payload.status_code || payload.current_status || payload.shipment_status || payload.order_status || '';
  const mapped = mapStatus(rawStatus);
  const checkpoints = (payload.checkpoints || payload.history || payload.scans || payload.events || payload.tracking_history || []).map(normaliseCheckpoint).filter(Boolean);
  const eta = payload.expected_delivery_date || payload.eta || payload.promised_delivery_date || payload.delivery_date || payload.edd || null;
  return { awb: payload.awb || payload.awb_number || payload.tracking_id || payload.waybill || payload.unique_code || '', orderId: payload.order_id || payload.orderId || payload.client_order_id || null, rawStatus, storeStatus: mapped ? mapped.store : null, statusLabel: mapped ? mapped.label : rawStatus, courier: payload.courier || payload.courier_name || 'Shadowfax', eta, deliveredAt: payload.delivered_at || payload.delivery_timestamp || payload.delivered_on || null, currentLocation: payload.current_location || payload.location || payload.last_scan_location || null, checkpoints, raw: payload };
}

async function syncStatusToSupabase({ orderId, awb, storeStatus, eta, deliveredAt }) {
  if (!AUTO_SYNC_TO_SUPABASE || !orderId || !storeStatus || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { skipped: true };
  const endpoint = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`;
  const body = { status: storeStatus, updated_at: new Date().toISOString() };
  if (awb) body.awb = awb; if (eta) body.eta = eta; if (deliveredAt) body.delivered_at = deliveredAt;
  try {
    const res = await fetchWithTimeout(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'return=minimal' }, body: JSON.stringify(body) }, 8000, 1);
    if (!res.ok) return { synced: false, status: res.status };
    return { synced: true, storeStatus };
  } catch (err) { return { synced: false, error: err.message }; }
}

exports.handler = async (event) => {
  const correlationId = `sft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'X-Correlation-Id': correlationId, 'Cache-Control': 'no-store' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ status: 'error', message: 'Method not allowed' }) };

  let input = {};
  try { input = event.httpMethod === 'GET' ? (event.queryStringParameters || {}) : JSON.parse(event.body || '{}'); } catch (err) { return { statusCode: 400, headers, body: JSON.stringify({ status: 'error', message: 'Invalid input' }) }; }

  const awb = normaliseAwb(input.awb || input.awb_number || input.tracking_id || input.waybill);
  const orderId = input.orderId || input.order_id || null;
  const apiKey = input.apiKey || input.api_key || DEFAULT_API_KEY;
  const shouldSync = input.sync !== 'false' && input.sync !== false;

  if (!awb) return { statusCode: 400, headers, body: JSON.stringify({ status: 'error', message: 'Missing required parameter: awb' }) };
  if (!apiKey) return { statusCode: 400, headers, body: JSON.stringify({ status: 'error', message: 'Shadowfax API key not configured. Set it in Netlify env vars.' }) };

  let raw;
  try { raw = await callShadowfaxTrack(awb, apiKey); } catch (err) { return { statusCode: 502, headers, body: JSON.stringify({ status: 'error', message: err.message || 'Failed to track shipment', details: err.body || null, correlationId }) }; }

  const normalised = normaliseShadowfaxResponse(raw);
  if (!normalised.awb) normalised.awb = awb;

  let sync = { skipped: true };
  if (shouldSync && normalised.storeStatus && (orderId || normalised.orderId)) {
    sync = await syncStatusToSupabase({ orderId: orderId || normalised.orderId, awb: normalised.awb, storeStatus: normalised.storeStatus, eta: normalised.eta, deliveredAt: normalised.deliveredAt });
  }

  return { statusCode: 200, headers, body: JSON.stringify({ status: 'success', awb: normalised.awb, orderId: orderId || normalised.orderId || null, rawStatus: normalised.rawStatus, storeStatus: normalised.storeStatus, statusLabel: normalised.statusLabel, courier: normalised.courier, eta: normalised.eta, deliveredAt: normalised.deliveredAt, currentLocation: normalised.currentLocation, checkpoints: normalised.checkpoints, sync, correlationId }) };
};