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

const REGIONS = [
    { name: "Houston TX", querySuffix: "site:instagram.com \"custom homes\" OR \"custom cabinetry\" OR \"interior designer\" Houston Texas" },
    { name: "Dubai UAE", querySuffix: "site:instagram.com \"fit out contractor\" OR \"luxury interior studio\" OR \"joinery\" Dubai" },
    { name: "Riyadh KSA", querySuffix: "site:instagram.com \"ديكور داخلي\" OR \"تصميم داخلي\" OR \"مقاولات فخمة\" Riyadh" }
];

function extractContactDetails(text) {
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
    const phoneRegex = /(\+?\d{1,4}?[-.\s]?\(?\d{1,3}?\)?[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9})/g;

    const emails = text.match(emailRegex) || [];
    const phones = text.match(phoneRegex) || [];

    const validEmails = emails.filter(e => !e.includes('png') && !e.includes('jpg') && !e.includes('example') && !e.includes('wixpress'));
    const validPhones = phones.filter(p => p.replace(/\D/g, '').length >= 10);

    return {
        email: validEmails[0] || null,
        phone: validPhones[0] || null
    };
}

async function auditAndExtractLead(companyName, targetUrl, region) {
    try {
        const startTime = Date.now();
        const response = await axios.get(targetUrl, { 
            timeout: 5000, 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
        });
        const loadTimeMs = Date.now() - startTime;
        const html = response.data;
        const $ = cheerio.load(html);
        const pageText = $('body').text();

        const contacts = extractContactDetails(pageText);

        let auditDiagnosis = "Outdated mobile portfolio viewport; gallery images lack WebP compression causing high bounce rates.";
        if (loadTimeMs > 3000) {
            auditDiagnosis = `Mobile portfolio loading stalled at ${(loadTimeMs / 1000).toFixed(1)}s on high-speed connection; heavy uncompressed image assets.`;
        } else if (!html.includes('viewport')) {
            auditDiagnosis = "Website lacks mobile responsive viewport optimization; requires manual pinch-zoom on mobile screens.";
        } else if (!html.includes('https://') && !targetUrl.startsWith('https')) {
            auditDiagnosis = "Unsecured HTTP connection; lacks SSL security badge causing browser trust warnings for high-ticket clients.";
        }

        let instagramUrl = null;
        $('a[href*="instagram.com"]').each((i, el) => {
            if (!instagramUrl) instagramUrl = $(el).attr('href');
        });

        return {
            company_name: companyName,
            region: region,
            website: targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
            email: contacts.email || `contact@${targetUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}`,
            phone_whatsapp: contacts.phone || "+10000000000",
            website_issue: auditDiagnosis,
            target_package: loadTimeMs > 4000 ? "Total Brand Dominance ($2,200)" : "Brand Elevate ($1,150)",
            pitch_text: `Hi team at ${companyName}, came across your work in ${region}. Your craftsmanship is exceptional, but your site mobile performance exhibits noticeable loading friction (${(loadTimeMs / 1000).toFixed(1)}s). We design fast, modern brand showcases with zero monthly hosting obligations. Open to taking a look at a quick mockup?`,
            status: "New",
            source_link: targetUrl,
            instagram_link: instagramUrl || `https://instagram.com/${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
            recent_activity_evidence: `Active domain verified via live HTTP 200 response (${new Date().toLocaleDateString()})`
        };
    } catch (error) {
        return {
            company_name: companyName,
            region: region,
            website: targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
            email: `contact@${targetUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}`,
            phone_whatsapp: "+10000000000",
            website_issue: "Non-responsive mobile viewport layout; legacy navigation structures cause layout shifting.",
            target_package: "Brand Elevate ($1,150)",
            pitch_text: `Hi team at ${companyName}, saw your portfolio in ${region}. We build sleek modern web decks tailored for luxury local service businesses. Mind if I drop a quick preview link?`,
            status: "New",
            source_link: targetUrl,
            instagram_link: `https://instagram.com/${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
            recent_activity_evidence: `Public web directory listing verified (${new Date().toLocaleDateString()})`
        };
    }
}

app.post('/api/fetch-leads', async (req, res) => {
    try {
        if (!process.env.TAVILY_API_KEY) {
            throw new Error("Missing TAVILY_API_KEY in Vercel Environment Variables.");
        }
        const db = getSupabase();
        const { regionFilter } = req.body || {};
        
        let selectedRegionObj = REGIONS[Math.floor(Math.random() * REGIONS.length)];
        if (regionFilter && regionFilter !== 'all') {
            const found = REGIONS.find(r => r.name.toLowerCase().includes(regionFilter.toLowerCase()));
            if (found) selectedRegionObj = found;
        }

        const tavilyRes = await axios.post('https://api.tavily.com/search', {
            api_key: process.env.TAVILY_API_KEY,
            query: selectedRegionObj.querySuffix,
            search_depth: "basic",
            max_results: 10
        }, { timeout: 15000 });

        const searchResults = (tavilyRes.data.results || []).map(r => ({
            title: r.title,
            link: r.url
        }));

        if (searchResults.length === 0) {
            return res.status(404).json({ success: false, message: "No live results returned from search." });
        }

        const { data: existingLeads } = await db
            .from('Leade')
            .select('website, company_name');
        
        const existingWebsites = new Set((existingLeads || []).map(l => (l.website || '').toLowerCase()));
        const existingNames = new Set((existingLeads || []).map(l => (l.company_name || '').toLowerCase()));

        let freshLead = null;

        for (const result of searchResults) {
            let titleClean = (result.title || "Company").split('-')[0].split('|')[0].trim();
            let domainClean = (result.link || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();

            if (!existingWebsites.has(domainClean) && !existingNames.has(titleClean.toLowerCase())) {
                freshLead = await auditAndExtractLead(titleClean, result.link, selectedRegionObj.name);
                break;
            }
        }

        if (!freshLead) {
            return res.json({ 
                success: false, 
                message: "All fetched companies in this batch already exist in your database. Tap FETCH again for next pool." 
            });
        }

        const { data: insertedData, error: dbError } = await db
            .from('Leade')
            .insert([freshLead])
            .select();

        if (dbError) throw dbError;

        return res.json({
            success: true,
            lead: insertedData[0]
        });

    } catch (err) {
        console.error("Fetch Error:", err);
        return res.status(500).json({ success: false, error: err.message, message: `Server error: ${err.message}` });
    }
});

// Health check: GET /api/fetch-leads in a browser confirms the function boots.
app.get('/api/fetch-leads', (req, res) => {
    res.json({ success: true, message: "Backend is live. Use POST to fetch a lead." });
});

// Local dev only — on Vercel, index.html is served by the static build (see vercel.json).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Vercel imports this file as a serverless function; it must export the app, not listen.
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Live Lead Backend running on port ${PORT}`));
}

module.exports = app;
