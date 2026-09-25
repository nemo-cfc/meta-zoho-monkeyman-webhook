import { createHmac, timingSafeEqual } from "node:crypto";

const {
  META_VERIFY_TOKEN,
  META_ACCESS_TOKEN,
  META_APP_SECRET,
  META_GRAPH_VERSION = "v25.0",
  ALLOW_UNSIGNED_WEBHOOKS = "false",

  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ACCOUNTS_URL = "https://accounts.zoho.in",
  ZOHO_API_BASE = "https://www.zohoapis.in/crm/v8",
  MONKEYMAN_MODULE_API_NAME = "monkeyman_paid_leads",

  // Optional JSON:
  // {
  //   "META_FORM_ID": {
  //     "serviceCategory": "Optimisation",
  //     "disposition": "New"
  //   }
  // }
  FORM_ROUTES_JSON = "{}",

  // Optional aliases if your Meta question field names differ.
  // Example:
  // {"website":"Existing_Site","products":"How_Many_Products"}
  EXTRA_FIELD_MAP_JSON = "{}"
} = process.env;

let zohoTokenCache = {
  accessToken: null,
  expiresAt: 0
};

function mustHave(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function parseJSON(value, fallback = {}) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return fallback;
  }
}

function safeEqual(a = "", b = "") {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function verifyMetaSignature(rawBody, signature) {
  if (!META_APP_SECRET) return ALLOW_UNSIGNED_WEBHOOKS === "true";
  if (!signature?.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", META_APP_SECRET)
      .update(rawBody, "utf8")
      .digest("hex");

  return safeEqual(expected, signature);
}

function flattenFieldData(fieldData = []) {
  const out = {};
  for (const item of fieldData) {
    if (!item?.name) continue;
    const values = Array.isArray(item.values) ? item.values : [];
    out[item.name] = values.length <= 1 ? (values[0] ?? "") : values;
  }
  return out;
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value[0];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function clip255(value) {
  return String(value || "").slice(0, 255);
}

function buildWhatReady(fields, webhookValue) {
  const userValue = firstValue(
    fields.what_s_ready,
    fields.whats_ready,
    fields.assets_ready,
    fields.what_is_ready
  );

  const metaBits = [
    `Source:Meta Lead Ads`,
    webhookValue.form_id ? `Form:${webhookValue.form_id}` : "",
    webhookValue.ad_id ? `Ad:${webhookValue.ad_id}` : "",
    webhookValue.page_id ? `Page:${webhookValue.page_id}` : ""
  ].filter(Boolean);

  const suffix = `[${metaBits.join(" | ")}]`;
  return clip255([userValue, suffix].filter(Boolean).join(" "));
}

function buildZohoRecord(metaLead, webhookValue) {
  const fields = flattenFieldData(metaLead.field_data);
  const routes = parseJSON(FORM_ROUTES_JSON, {});
  const extraMap = parseJSON(EXTRA_FIELD_MAP_JSON, {});
  const route = routes[String(webhookValue.form_id || metaLead.form_id || "")] || {};

  const record = {
    Name: firstValue(
      fields.full_name,
      fields.name,
      [fields.first_name, fields.last_name].filter(Boolean).join(" "),
      "Meta Lead"
    ),
    Email: firstValue(fields.email),
    Phone: firstValue(fields.phone_number, fields.phone, fields.mobile),
    Secondary_Email: firstValue(fields.secondary_email),
    Existing_Site: firstValue(
      fields.existing_site,
      fields.store_url,
      fields.website,
      fields.website_url,
      fields.shopify_store_url
    ),
    Current_Platform: firstValue(
      fields.current_platform,
      fields.platform,
      fields.current_ecommerce_platform
    ),
    How_Many_Products: toArray(
      fields.how_many_products ??
      fields.number_of_products ??
      fields.product_count
    ),
    Monthly_Sessions: firstValue(
      fields.monthly_sessions,
      fields.monthly_traffic,
      fields.website_traffic
    ),
    Service_Category: firstValue(
      route.serviceCategory,
      fields.service_category,
      fields.service
    ),
    What_s_Ready: buildWhatReady(fields, webhookValue),
    Biggest_symptom: firstValue(
      fields.biggest_symptom,
      fields.biggest_problem,
      fields.main_problem,
      fields.challenge,
      fields.message
    )
  };

  const disposition = firstValue(
    route.disposition,
    fields.disposition_after_p,
    fields.disposition
  );
  if (disposition) record.Disposition_after_p = disposition;

  // Optional aliases: Meta field name -> Zoho API field name.
  // This lets you map additional questions without changing code.
  for (const [metaFieldName, zohoApiName] of Object.entries(extraMap)) {
    if (!(metaFieldName in fields)) continue;
    const raw = fields[metaFieldName];

    if (zohoApiName === "How_Many_Products") {
      record[zohoApiName] = toArray(raw);
    } else if (zohoApiName === "What_s_Ready") {
      record[zohoApiName] = clip255(raw);
    } else {
      record[zohoApiName] = Array.isArray(raw) ? raw.join(", ") : raw;
    }
  }

  // Avoid sending blank optional values except fields whose type/shape is useful.
  for (const [key, value] of Object.entries(record)) {
    if (key === "How_Many_Products") continue;
    if (value === "" || value === null || value === undefined) delete record[key];
  }

  return record;
}

async function fetchMetaLead(leadgenId) {
  mustHave(["META_ACCESS_TOKEN"]);

  const version = META_GRAPH_VERSION.startsWith("v")
    ? META_GRAPH_VERSION
    : `v${META_GRAPH_VERSION}`;

  const url = new URL(`https://graph.facebook.com/${version}/${leadgenId}`);
  url.searchParams.set("fields", "id,created_time,field_data,ad_id,form_id");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`
    }
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meta lead fetch failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

async function getZohoAccessToken() {
  mustHave(["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"]);

  const now = Date.now();
  if (
    zohoTokenCache.accessToken &&
    now < zohoTokenCache.expiresAt - 60_000
  ) {
    return zohoTokenCache.accessToken;
  }

  const body = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token"
  });

  const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho OAuth refresh failed (${res.status}): ${JSON.stringify(data)}`);
  }

  zohoTokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000
  };

  return data.access_token;
}

async function createMonkeymanLead(record) {
  const accessToken = await getZohoAccessToken();

  const res = await fetch(
    `${ZOHO_API_BASE}/${encodeURIComponent(MONKEYMAN_MODULE_API_NAME)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [record],
        trigger: ["workflow", "approval"]
      })
    }
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Zoho CRM insert failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const result = body?.data?.[0];
  if (result?.status === "error") {
    throw new Error(`Zoho CRM rejected lead: ${JSON.stringify(result)}`);
  }

  return body;
}

async function processLeadgen(value) {
  if (!value?.leadgen_id) throw new Error("Missing leadgen_id");

  const metaLead = await fetchMetaLead(value.leadgen_id);
  const zohoRecord = buildZohoRecord(metaLead, value);
  const zohoResponse = await createMonkeymanLead(zohoRecord);

  console.log(
    JSON.stringify({
      event: "monkeyman_meta_lead_synced",
      metaLeadId: value.leadgen_id,
      formId: value.form_id || null,
      zohoStatus: zohoResponse?.data?.[0]?.status || "unknown",
      zohoCode: zohoResponse?.data?.[0]?.code || "unknown"
    })
  );
}

async function processWebhook(payload) {
  if (payload?.object !== "page") {
    return { ignored: true, reason: "not_page_object" };
  }

  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "leadgen") continue;
      jobs.push(processLeadgen(change.value));
    }
  }

  if (!jobs.length) return { ignored: true, reason: "no_leadgen_changes" };

  await Promise.all(jobs);
  return { processed: jobs.length };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Meta verification handshake
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const verifyToken = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (
        mode === "subscribe" &&
        META_VERIFY_TOKEN &&
        safeEqual(verifyToken, META_VERIFY_TOKEN)
      ) {
        return new Response(challenge || "", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }

      return Response.json(
        { error: "Webhook verification failed" },
        { status: 403 }
      );
    }

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const rawBody = await request.text();
      const signature = request.headers.get("x-hub-signature-256");

      if (!verifyMetaSignature(rawBody, signature)) {
        return Response.json(
          { error: "Invalid Meta webhook signature" },
          { status: 401 }
        );
      }

      const payload = JSON.parse(rawBody);
      const result = await processWebhook(payload);

      return Response.json({ ok: true, ...result });
    } catch (error) {
      console.error(error);
      // Non-2xx response lets Meta retry failed webhook deliveries.
      return Response.json(
        { ok: false, error: error.message || "Webhook processing failed" },
        { status: 500 }
      );
    }
  }
};
