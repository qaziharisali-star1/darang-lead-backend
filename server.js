require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const LEADS_PER_FETCH = 5;
const TABLE = 'Leade';

// Lazy init: creating the client at module load crashes the whole function
// (FUNCTION_INVOCATION_FAILED) when an env var is missing on Vercel.
let supabase = null;
function getSupabase() {
    if (!supabase) {
        const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
            throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.");
        }
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }
    return supabase;
}

// Each FETCH picks one random query from the region, so repeat taps reach different companies.
const REGIONS = [
    {
        name: "Houston TX",
        queries: [
            "custom home builder Houston Texas",
            "custom cabinetry company Houston TX",
            "interior design studio Houston Texas",
            "luxury kitchen remodeling Houston",
            "millwork and joinery company Houston TX"
        ]
    },
    {
        name: "Dubai UAE",
        queries: [
            "fit out contractor Dubai",
            "luxury interior design studio Dubai",
            "joinery company Dubai UAE",
            "villa renovation company Dubai",
            "bespoke furniture maker Dubai"
        ]
    },
    {
        name: "Riyadh KSA",
        queries: [
            "interior design company Riyadh",
            "fit out contractor Riyadh Saudi Arabia",
            "شركة تصميم داخلي الرياض",
            "luxury villa interior Riyadh",
            "joinery and woodwork company Riyadh"
        ]
    }
];

// Social networks, directories and marketplaces are not a company's own website.
const EXCLUDED_DOMAINS = [
    'instagram.com', 'facebook.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
    'youtube.com', 'pinterest.com', 'houzz.com', 'yelp.com', 'yellowpages.com', 'bbb.org',
    'angi.com', 'homeadvisor.com', 'thumbtack.com', 'nextdoor.com', 'reddit.com', 'quora.com',
    'wikipedia.org', 'tripadvisor.com', 'google.com', 'yelp.ae', 'dubizzle.com',
    'bayut.com', 'propertyfinder.ae', 'clutch.co', 'designrush.com', 'architizer.com', 'archdaily.com',
    'medium.com', 'glassdoor.com', 'indeed.com', 'zillow.com', 'realtor.com', 'amazon.com'
];

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function isExcluded(host) {
    return EXCLUDED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

const BAD_EMAIL = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|example\.|wixpress|sentry|@2x|domain\.com|email\.com|yourname|godaddy)/i;

// Only real contacts: mailto/tel/wa.me links first, then visible text. Nothing is ever invented.
function extractContacts($) {
    let email = null, phone = null;

    $('a[href^="mailto:"]').each((i, el) => {
        const v = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
        if (!email && v.includes('@') && !BAD_EMAIL.test(v)) email = v;
    });
    $('a[href*="wa.me/"], a[href*="api.whatsapp.com"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/wa\.me\/(\d{8,15})/) || href.match(/phone=(\d{8,15})/);
        if (!phone && m) phone = '+' + m[1];
    });
    $('a[href^="tel:"]').each((i, el) => {
        const v = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
        if (!phone && v.replace(/\D/g, '').length >= 9) phone = v;
    });

    if (!email) {
        const text = $('body').text();
        const found = (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).find(e => !BAD_EMAIL.test(e));
        if (found) email = found;
    }
    return { email, phone };
}

function companyNameFrom($, fallbackTitle, host) {
    const og = $('meta[property="og:site_name"]').attr('content');
    const raw = (og || $('title').first().text() || fallbackTitle || host || '').trim();
    const name = raw.split(/\s[|\-–—:]\s/)[0].trim();
    return (name && name.length <= 80) ? name : host;
}

// Fetch a URL and time it. Returns null if the site is unreachable.
async function getPage(url, timeout = 7000) {
    try {
        const t0 = Date.now();
        const res = await axios.get(url, { timeout, headers: UA, maxRedirects: 5, responseType: 'text' });
        if (typeof res.data !== 'string') return null;
        return { html: res.data, ms: Date.now() - t0, finalUrl: (res.request && res.request.res && res.request.res.responseUrl) || url };
    } catch {
        return null;
    }
}

// Audit only what was actually measured on the company's own site.
async function auditLead(result, regionName) {
    const page = await getPage(result.url);
    if (!page) return null; // unreachable site = not a verifiable lead

    const host = hostOf(page.finalUrl);
    if (!host || isExcluded(host)) return null;

    const $ = cheerio.load(page.html);
    let { email, phone } = extractContacts($);

    // Contact details often live on a contact page — check it once if the homepage lacked them.
    if (!email || !phone) {
        try {
            const origin = new URL(page.finalUrl).origin;
            const contactHref = $('a[href*="contact"]').first().attr('href');
            const contactUrl = contactHref ? new URL(contactHref, origin).href : origin + '/contact';
            const cp = await getPage(contactUrl, 5000);
            if (cp) {
                const c = extractContacts(cheerio.load(cp.html));
                email = email || c.email;
                phone = phone || c.phone;
            }
        } catch { /* contact page optional */ }
    }

    const issues = [];
    const secs = (page.ms / 1000).toFixed(1);
    if (page.ms > 3000) issues.push(`homepage took ${secs}s to respond in a server test`);
    if (!/<meta[^>]+name=["']viewport["']/i.test(page.html)) issues.push('no mobile viewport tag, so the site likely renders zoomed-out on phones');
    if (!page.finalUrl.startsWith('https://')) issues.push('site loads without HTTPS, so browsers show a "Not secure" warning');
    const imgs = $('img');
    const modernImgs = imgs.filter((i, el) => /\.(webp|avif)(\?|$)/i.test($(el).attr('src') || '') || /webp|avif/i.test($(el).attr('srcset') || '')).length;
    if (imgs.length >= 8 && modernImgs === 0) issues.push(`${imgs.length} images on the homepage and none in WebP/AVIF format`);
    const htmlKb = Math.round(Buffer.byteLength(page.html) / 1024);
    if (htmlKb > 600) issues.push(`homepage HTML alone is ${htmlKb} KB`);
    const year = new Date().getFullYear();
    const copyright = (page.html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i) || [])[1];
    if (copyright && Number(copyright) <= year - 3) issues.push(`footer copyright still says ${copyright}, which signals an unmaintained site`);

    let instagramUrl = null;
    $('a[href*="instagram.com/"]').each((i, el) => {
        if (!instagramUrl) instagramUrl = $(el).attr('href');
    });

    const company = companyNameFrom($, result.title, host);
    const hasIssues = issues.length > 0;

    const pitch = hasIssues
        ? `Hi ${company} team, I came across your work in ${regionName}. While looking at ${host} I noticed: ${issues[0]}. Fixing that tends to keep more mobile visitors on the page. We build fast, modern showcase sites for premium design and build studios. Would a quick mockup of your homepage be useful?`
        : `Hi ${company} team, I came across your work in ${regionName}. Your site is already in good shape. We produce cinematic AI product and project films for premium studios. Open to seeing a short sample made from one of your projects?`;

    return {
        company_name: company,
        region: regionName,
        website: host,
        email: email || null,
        phone_whatsapp: phone || null,
        website_issue: hasIssues
            ? issues.map(s => s[0].toUpperCase() + s.slice(1)).join('; ') + '.'
            : 'No major website issues found. Low priority for a web redesign pitch.',
        target_package: issues.length >= 2 ? "Total Brand Dominance ($2,200)" : (hasIssues ? "Brand Elevate ($1,150)" : "Content / AI film pitch"),
        pitch_text: pitch,
        status: hasIssues ? "New" : "Low priority",
        source_link: page.finalUrl,
        instagram_link: instagramUrl,
        recent_activity_evidence: `Site reachable on ${new Date().toISOString().slice(0, 10)} (${secs}s response)`
    };
}

app.post('/api/fetch-leads', async (req, res) => {
    try {
        if (!process.env.TAVILY_API_KEY) {
            throw new Error("Missing TAVILY_API_KEY in Vercel Environment Variables.");
        }
        const db = getSupabase();
        const { regionFilter } = req.body || {};

        let region = REGIONS[Math.floor(Math.random() * REGIONS.length)];
        if (regionFilter && regionFilter !== 'all') {
            const found = REGIONS.find(r => r.name.toLowerCase().includes(regionFilter.toLowerCase()));
            if (found) region = found;
        }
        const query = region.queries[Math.floor(Math.random() * region.queries.length)];

        // One Tavily search per FETCH (1 credit on basic depth). Site checks below don't use Tavily.
        const tavilyRes = await axios.post('https://api.tavily.com/search', {
            api_key: process.env.TAVILY_API_KEY,
            query,
            search_depth: "basic",
            max_results: 20,
            exclude_domains: EXCLUDED_DOMAINS
        }, { timeout: 15000 });

        const { data: existing } = await db.from(TABLE).select('website, company_name');
        const seenHosts = new Set((existing || []).map(l => (l.website || '').toLowerCase()));
        const seenNames = new Set((existing || []).map(l => (l.company_name || '').toLowerCase()));

        // Keep one result per company domain that isn't already in the CRM.
        const candidates = [];
        for (const r of (tavilyRes.data.results || [])) {
            const host = hostOf(r.url);
            if (!host || isExcluded(host) || seenHosts.has(host)) continue;
            seenHosts.add(host);
            candidates.push({ title: r.title, url: r.url });
        }

        if (candidates.length === 0) {
            return res.json({ success: false, message: `No new company websites found for "${query}". Tap FETCH again.` });
        }

        // Audit up to 8 sites in parallel and keep the first 5 that are reachable.
        const audited = await Promise.all(candidates.slice(0, 8).map(c => auditLead(c, region.name)));
        const leads = [];
        for (const lead of audited) {
            if (!lead) continue;
            const key = lead.company_name.toLowerCase();
            if (seenNames.has(key)) continue;
            seenNames.add(key);
            leads.push(lead);
            if (leads.length >= LEADS_PER_FETCH) break;
        }

        if (leads.length === 0) {
            return res.json({ success: false, message: "Found companies, but none had a reachable website. Tap FETCH again." });
        }

        // Leads with a real website issue go first.
        leads.sort((a, b) => (a.status === 'New' ? 0 : 1) - (b.status === 'New' ? 0 : 1));

        const { error: dbError } = await db
            .from(TABLE)
            .upsert(leads, { onConflict: 'company_name', ignoreDuplicates: true });

        if (dbError) throw dbError;

        return res.json({ success: true, query, leads });

    } catch (err) {
        console.error("Fetch Error:", err);
        return res.status(500).json({ success: false, error: err.message, message: `Server error: ${err.message}` });
    }
});

// Health check: GET /api/fetch-leads in a browser confirms the function boots.
app.get('/api/fetch-leads', (req, res) => {
    res.json({ success: true, message: "Backend is live. Use POST to fetch leads." });
});

// Local dev only — on Vercel, index.html is served by the static build (see vercel.json).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Vercel imports this file as a serverless function; it must export the app, not listen.
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Live Lead Backend running on port ${PORT}`));
}

module.exports = app;
