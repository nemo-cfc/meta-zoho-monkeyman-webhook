# Meta Instant Lead Forms -> MonkeyMan Zoho CRM

This project is adapted to the **verified Zoho configuration in `monkeyman-developer-spec-v3.md`**.

## Final flow

```text
Meta Instant Form
    ↓
Meta Page webhook (`leadgen`)
    ↓
leadgen_id
    ↓
Meta Graph API fetches full lead
    ↓
Field normalization
    ↓
Zoho India OAuth refresh
    ↓
POST /crm/v8/monkeyman_paid_leads
```

## Zoho target

```text
Data center: India
OAuth:       https://accounts.zoho.in/oauth/v2/token
API base:    https://www.zohoapis.in/crm/v8
Module:      monkeyman_paid_leads
```

The actual client ID / secret / refresh token are intentionally **not baked into this project**. Copy them from your private MonkeyMan developer specification into Vercel Environment Variables.

---

## Verified field mapping

| Meta / normalized value | Zoho API field |
|---|---|
| Full name | `Name` |
| Email | `Email` |
| Phone / WhatsApp | `Phone` |
| Secondary email | `Secondary_Email` |
| Store / existing site URL | `Existing_Site` |
| Current platform | `Current_Platform` |
| Product range | `How_Many_Products` |
| Monthly sessions | `Monthly_Sessions` |
| Service category | `Service_Category` |
| Assets / readiness + Meta attribution | `What_s_Ready` |
| Main problem / symptom | `Biggest_symptom` |
| Optional disposition | `Disposition_after_p` |

### Important

`How_Many_Products` is always converted to a JSON array, e.g.

```json
["100 - 500"]
```

`What_s_Ready` is clipped to 255 characters.

---

# 1. Deploy to Vercel

From this folder:

```bash
vercel
```

Then add the variables in `.env.example` under:

```text
Vercel
→ Project
→ Settings
→ Environment Variables
```

Deploy production:

```bash
vercel --prod
```

Your endpoint will be:

```text
https://YOUR-PROJECT.vercel.app/api/meta-leads
```

---

# 2. Configure Meta webhook

In your Meta App:

```text
Webhooks
→ Page
```

Callback URL:

```text
https://YOUR-PROJECT.vercel.app/api/meta-leads
```

Verify Token:

```text
the same value as META_VERIFY_TOKEN
```

Subscribe to:

```text
leadgen
```

The verification request is handled automatically by this project.

---

# 3. Required Meta credentials

You need:

```text
META_ACCESS_TOKEN
META_APP_SECRET
META_VERIFY_TOKEN
```

`META_VERIFY_TOKEN` is not supplied by Meta. It is a random secret you create yourself and enter in both Vercel and Meta.

The Meta access token must be able to retrieve leads belonging to the Page / Instant Form.

---

# 4. Route each Meta form to the right MonkeyMan service

The Zoho schema expects:

```text
Optimisation
Setup
Migration
Development
```

Configure the Meta Form IDs through `FORM_ROUTES_JSON`.

Example:

```json
{
  "111111111111": {
    "serviceCategory": "Optimisation"
  },
  "222222222222": {
    "serviceCategory": "Setup"
  },
  "333333333333": {
    "serviceCategory": "Migration"
  },
  "444444444444": {
    "serviceCategory": "Development"
  }
}
```

In Vercel this becomes one line:

```text
FORM_ROUTES_JSON={"111111111111":{"serviceCategory":"Optimisation"},"222222222222":{"serviceCategory":"Setup"},"333333333333":{"serviceCategory":"Migration"},"444444444444":{"serviceCategory":"Development"}}
```

---

# 5. Meta Instant Form question names

The webhook already recognizes common aliases.

### Name

```text
full_name
name
first_name + last_name
```

### Phone

```text
phone_number
phone
mobile
```

### Website

```text
existing_site
store_url
website
website_url
shopify_store_url
```

### Current platform

```text
current_platform
platform
current_ecommerce_platform
```

### Products

```text
how_many_products
number_of_products
product_count
```

### Monthly sessions

```text
monthly_sessions
monthly_traffic
website_traffic
```

### Biggest problem

```text
biggest_symptom
biggest_problem
main_problem
challenge
message
```

If your form uses different internal field names, configure:

```text
EXTRA_FIELD_MAP_JSON
```

Example:

```text
EXTRA_FIELD_MAP_JSON={"shop_url":"Existing_Site","product_range":"How_Many_Products"}
```

---

# 6. Test webhook verification

```bash
curl "https://YOUR-PROJECT.vercel.app/api/meta-leads?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
```

Expected response:

```text
12345
```

---

# 7. Test with a real Meta test lead

Use Meta's Lead Ads Testing Tool to create a test submission.

The webhook receives roughly:

```json
{
  "object": "page",
  "entry": [
    {
      "changes": [
        {
          "field": "leadgen",
          "value": {
            "leadgen_id": "LEAD_ID",
            "form_id": "FORM_ID",
            "page_id": "PAGE_ID",
            "ad_id": "AD_ID"
          }
        }
      ]
    }
  ]
}
```

The webhook then calls Graph API using the `leadgen_id` and sends the real answers to Zoho.

---

# 8. Zoho payload shape

A resulting record can look like:

```json
{
  "data": [
    {
      "Name": "Example Founder",
      "Email": "founder@example.com",
      "Phone": "+15551234567",
      "Existing_Site": "https://example.com",
      "Current_Platform": "Shopify",
      "How_Many_Products": ["100 - 500"],
      "Monthly_Sessions": "10k - 50k",
      "Service_Category": "Optimisation",
      "What_s_Ready": "Brand assets ready [Source:Meta Lead Ads | Form:123 | Ad:456]",
      "Biggest_symptom": "Low conversion rate"
    }
  ],
  "trigger": ["workflow", "approval"]
}
```

---

# 9. Production security

Keep these only as server-side environment variables:

```text
META_ACCESS_TOKEN
META_APP_SECRET
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
```

Do not put them into landing-page JavaScript.

Webhook POST requests are validated against Meta's `X-Hub-Signature-256` using `META_APP_SECRET`.

---

# 10. What remains to make the mapping exact

The backend is ready for the MonkeyMan Zoho schema.

The only Meta-specific information still needed for exact routing is:

1. the actual Meta **Instant Form IDs**, and
2. the internal `field_data[].name` values of any custom questions whose names differ from the aliases in this project.

Those can be obtained from one test lead per form.

## Confirmed Meta form

Instant Form ID: `1605636074299074`.
Choose its Service_Category (Optimisation, Setup, Migration, or Development) before adding its route to FORM_ROUTES_JSON.

