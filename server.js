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
const DAILY_LIMIT = Number(process.env.DAILY_LEAD_LIMIT) || 25;

// Leads saved since midnight Pakistan time.
async function countToday(db) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()); // YYYY-MM-DD
    const start = new Date(`${day}T00:00:00+05:00`).toISOString();
    const { count, error } = await db.from(TABLE).select('company_name', { count: 'exact', head: true }).gte('created_at', start);
    if (error) throw error;
    return count || 0;
}

// Live Tavily credit usage for this billing cycle (null if unavailable).
async function tavilyUsage() {
    try {
        const r = await axios.get('https://api.tavily.com/usage', {
            headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
            timeout: 5000
        });
        const a = r.data.account || {};
        const k = r.data.key || {};
        return {
            used: a.plan_usage != null ? a.plan_usage : k.usage,
            limit: a.plan_limit != null ? a.plan_limit : k.limit,
            plan: a.current_plan || null
        };
    } catch {
        return null;
    }
}
const STATUSES = ['New', 'Contacted', 'Replied', 'Won', 'Lost', 'Low priority'];

// Optional lock: if CRM_ACCESS_KEY is set in Vercel, every data request must send it.
function requireKey(req, res, next) {
    const key = process.env.CRM_ACCESS_KEY;
    if (!key || req.get('x-crm-key') === key) return next();
    return res.status(401).json({ success: false, auth: true, message: "Enter your CRM access key." });
}
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

const MIN_SCORE = 50;

const ROLE_RE = /\b(co-?founder|founder|owner|ceo|chief executive|managing director|managing partner|principal|president|creative director|design director|general manager|director)\b/i;
const NOT_NAME = new Set(('our the team meet about us interior interiors design designs studio studios company group llc ltd inc fzco fze ' +
    'contracting contractors construction home homes kitchen kitchens dubai riyadh houston texas saudi arabia uae ' +
    'founder owner director managing principal partner president chief executive creative general manager ' +
    'and of for with at by in on read more view contact services projects portfolio leadership welcome').split(' '));

function looksLikeName(str) {
    const words = str.trim().split(/\s+/);
    if (words.length < 2 || words.length > 4) return false;
    return words.every(w => /^[A-Z][a-zA-Z'’.-]{1,20}$/.test(w) && !NOT_NAME.has(w.toLowerCase().replace(/[.'’]/g, '')));
}

// Find a named decision-maker. Only returns a person the site actually names next to a senior role.
function findDecisionMaker($) {
    // 1. Structured data (schema.org founder / employee)
    let found = null;
    $('script[type="application/ld+json"]').each((i, el) => {
        if (found) return;
        try {
            const json = JSON.parse($(el).contents().text());
            const nodes = [].concat(json['@graph'] || json);
            for (const n of nodes) {
                const f = n && (n.founder || n.founders);
                const person = Array.isArray(f) ? f[0] : f;
                const name = person && (typeof person === 'string' ? person : person.name);
                if (name && looksLikeName(name)) { found = { name, role: 'Founder' }; return; }
            }
        } catch { /* ignore bad JSON-LD */ }
    });
    if (found) return found;

    // 2. Visible text: "Name — Founder", "Founder: Name", or a name heading followed by a role line
    const blocks = $('h1,h2,h3,h4,h5,h6,p,li,strong,b,span,figcaption,div').toArray();
    for (let i = 0; i < blocks.length && !found; i++) {
        const el = blocks[i];
        if ($(el).children().length > 3) continue;
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text || text.length > 140) continue;
        const role = text.match(ROLE_RE);
        if (!role) continue;

        const parts = text.split(/\s*[,|–—:•\-]\s*|\s{2,}/).map(t => t.trim()).filter(Boolean);
        const name = parts.find(looksLikeName);
        if (name) { found = { name, role: role[0].replace(/^\w/, c => c.toUpperCase()) }; break; }

        const prev = $(el).prev().text().replace(/\s+/g, ' ').trim();
        if (looksLikeName(prev)) { found = { name: prev, role: role[0].replace(/^\w/, c => c.toUpperCase()) }; break; }
    }
    return found;
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

    let person = findDecisionMaker($);

    // Contact and About pages fetched in parallel (no Tavily credits used).
    const origin = new URL(page.finalUrl).origin;
    const linkTo = (re, fallback) => {
        const href = $('a[href]').filter((i, el) => re.test($(el).attr('href') || '') || re.test($(el).text())).first().attr('href');
        try { return href ? new URL(href, origin).href : origin + fallback; } catch { return origin + fallback; }
    };
    const needContact = !email || !phone;
    const [cp, ap] = await Promise.all([
        needContact ? getPage(linkTo(/contact/i, '/contact'), 5000) : null,
        !person ? getPage(linkTo(/about|team|founder|leadership|our-story|who-we-are/i, '/about'), 5000) : null
    ]);
    for (const extra of [cp, ap]) {
        if (!extra) continue;
        const $x = cheerio.load(extra.html);
        const c = extractContacts($x);
        email = email || c.email;
        phone = phone || c.phone;
        if (!person) person = findDecisionMaker($x);
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

    // Lead score: only from what was actually found on their site.
    const breakdown = {
        email: email ? 25 : 0,
        phone: phone ? 25 : 0,
        decision_maker: person ? 20 : 0,
        website_issues: issues.length >= 3 ? 20 : issues.length === 2 ? 15 : issues.length === 1 ? 10 : 0,
        instagram: instagramUrl ? 10 : 0
    };
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    if (score < MIN_SCORE) return null; // weak lead: not saved, doesn't count toward the daily 25
    const greet = person ? person.name.split(' ')[0] : `${company} team`;

    const pitch = hasIssues
        ? `Hi ${greet}, I came across ${company}'s work in ${regionName}. While looking at ${host} I noticed: ${issues[0]}. Fixing that tends to keep more mobile visitors on the page. We build fast, modern showcase sites for premium design and build studios. Would a quick mockup of your homepage be useful?`
        : `Hi ${greet}, I came across ${company}'s work in ${regionName}. Your site is already in good shape. We produce cinematic AI product and project films for premium studios. Open to seeing a short sample made from one of your projects?`;

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
        status: "New",
        source_link: page.finalUrl,
        instagram_link: instagramUrl,
        lead_score: score,
        score_breakdown: breakdown,
        contact_name: person ? person.name : null,
        contact_role: person ? person.role : null,
        recent_activity_evidence: `Site reachable on ${new Date().toISOString().slice(0, 10)} (${secs}s response)`
    };
}

app.post('/api/fetch-leads', requireKey, async (req, res) => {
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

        // Daily cap is checked BEFORE searching, so a full day costs zero extra Tavily credits.
        const todayCount = await countToday(db);
        const remaining = DAILY_LIMIT - todayCount;
        if (remaining <= 0) {
            return res.json({
                success: false,
                limitReached: true,
                todayCount,
                dailyLimit: DAILY_LIMIT,
                message: `Daily limit reached: ${todayCount}/${DAILY_LIMIT} leads today. New leads unlock after midnight (Pakistan time).`
            });
        }
        const batchSize = Math.min(LEADS_PER_FETCH, remaining);

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

        // Audit up to 12 sites in parallel (free) and keep the best-scoring ones.
        const audited = await Promise.all(candidates.slice(0, 12).map(c => auditLead(c, region.name)));
        const leads = [];
        audited.sort((a, b) => (b ? b.lead_score : -1) - (a ? a.lead_score : -1));
        for (const lead of audited) {
            if (!lead) continue;
            const key = lead.company_name.toLowerCase();
            if (seenNames.has(key)) continue;
            seenNames.add(key);
            leads.push(lead);
            if (leads.length >= batchSize) break;
        }

        if (leads.length === 0) {
            return res.json({ success: false, message: `Checked ${Math.min(candidates.length, 12)} companies, none scored ${MIN_SCORE}+ (real contacts are missing). Tap FETCH for another batch.` });
        }


        const { error: dbError } = await db
            .from(TABLE)
            .upsert(leads, { onConflict: 'company_name', ignoreDuplicates: true });

        if (dbError) throw dbError;

        return res.json({ success: true, query, leads, todayCount: todayCount + leads.length, dailyLimit: DAILY_LIMIT });

    } catch (err) {
        console.error("Fetch Error:", err);
        return res.status(500).json({ success: false, error: err.message, message: `Server error: ${err.message}` });
    }
});

// Today's lead count and Tavily credit usage.
app.get('/api/stats', requireKey, async (req, res) => {
    try {
        const [todayCount, tavily] = await Promise.all([countToday(getSupabase()), tavilyUsage()]);
        return res.json({ success: true, todayCount, dailyLimit: DAILY_LIMIT, tavily });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
    }
});

// Saved leads, newest first.
app.get('/api/leads', requireKey, async (req, res) => {
    try {
        const { data, error } = await getSupabase()
            .from(TABLE)
            .select('*')
            .order('created_at', { ascending: false, nullsFirst: false })
            .limit(1000);
        if (error) throw error;
        return res.json({ success: true, leads: data || [] });
    } catch (err) {
        console.error("List Error:", err);
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
    }
});

// Change a lead's pipeline status.
app.post('/api/leads/status', requireKey, async (req, res) => {
    try {
        const { company_name, status } = req.body || {};
        if (!company_name || !STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid lead or status." });
        }
        const { data, error } = await getSupabase()
            .from(TABLE)
            .update({ status })
            .eq('company_name', company_name)
            .select();
        if (error) throw error;
        if (!data || !data.length) return res.status(404).json({ success: false, message: "Lead not found." });
        return res.json({ success: true, lead: data[0] });
    } catch (err) {
        console.error("Status Error:", err);
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
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
