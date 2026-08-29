import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as cheerio from 'cheerio';

const app = new Hono();
app.use('*', cors());

const BASE_URL = 'https://tv12.lk21official.cc';
const CACHE_TTL = 3600; 
const MAX_PAGE = 15;    

app.get('/', (c) => scrapePage(c, 'latest', 'latest', c.req.query('page')));
app.get('/populer', (c) => scrapePage(c, 'populer', 'populer', c.req.query('page')));
app.get('/genre/:name', (c) => scrapePage(c, `genre_${c.req.param('name')}`, `genre/${c.req.param('name')}`, c.req.query('page')));

async function scrapePage(c, cacheKey, pathPrefix, page) {
    const pageNum = parseInt(page || '1', 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > MAX_PAGE) {
        return c.json({ error: true, error_msg: `Halaman dibatasi max ${MAX_PAGE}` }, 400);
    }
    const forceRefresh = c.req.query('refresh') === 'true';

    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(`${cacheKey}_p${pageNum}`, { type: 'json' });
            if (cachedData && cachedData.data?.length > 0) return c.json({ status: true, source: "KV Cache", ...cachedData });
        } catch (e) { }
    }

    const targetUrl = pageNum === 1 ? `${BASE_URL}/${pathPrefix}/` : `${BASE_URL}/${pathPrefix}/page/${pageNum}/`;

    try {
        const res = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (!res.ok) return c.json({ error: true, error_msg: "Gagal scrape LK21" }, 400);

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('.movie-box, article, .grid-item, .search-item').each((_, el) => {
            const $link = $(el).find('a').first();
            const $img = $(el).find('img').first();
            const href = $link.attr('href');
            if (!href || href.includes('/genre/')) return;

            const judul = $img.attr('alt') || $link.attr('title') || $(el).find('h2, h3').text().trim();
            let thumbnail = $img.attr('src') || $img.attr('data-src');
            if (thumbnail && thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
            const slug = href.replace(/https?:\/\/[^\/]+/, '').replace(/^\/|\/$/g, '');
            
            if (judul && slug && !results.some(r => r.slug === slug)) {
                results.push({ judul: judul.replace(/Permalink to /i, ''), slug, thumbnail });
            }
        });

        const responseData = { page: pageNum, max_page: MAX_PAGE, total_data: results.length, data: results };
        if (results.length > 0) await c.env.LK21_KV.put(`${cacheKey}_p${pageNum}`, JSON.stringify(responseData), { expirationTtl: CACHE_TTL });
        return c.json({ status: true, source: "Live Scrape", ...responseData });
    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
}

// 7. ENDPOINT DETAIL (SUPER EXTRACTOR)
app.get('/detail/:slug', async (c) => {
    const slug = c.req.param('slug');
    const cacheKey = `detail_${slug}`;
    const forceRefresh = c.req.query('refresh') === 'true';

    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(cacheKey, { type: 'json' });
            if (cachedData) return c.json({ status: true, source: "KV Cache", ...cachedData });
        } catch (e) { }
    }

    try {
        const res = await fetch(`${BASE_URL}/${slug}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (!res.ok) return c.json({ error: true, error_msg: "Gagal mengambil detail" }, 400);

        const html = await res.text();
        const $ = cheerio.load(html);

        // --- EKSTRAK METADATA ---
        const title = $("#movie-detail blockquote > a").text().trim() || "N/A";
        const status = $("#movie-detail .content h3").eq(0).text().trim() || "N/A";
        const quality = $("#movie-detail .content h3").eq(1).text().trim() || "N/A";
        const diterbitkan = $("#movie-detail .content").find("div:contains('Diterbitkan')").text().replace("Diterbitkan", "").trim() || "N/A";
        const sinopsis = $('.synopsis, #movie-detail p').text().trim() || "Sinopsis tidak tersedia.";

        let bintang_film = [];
        $("#movie-detail > div > div.col-xs-9.content > div:nth-child(3) h3 a, .content h3 a").each((_, el) => {
            const nama = $(el).text().trim();
            if (nama && !bintang_film.includes(nama)) bintang_film.push(nama);
        });

        const genres = [];
        $('a[href*="/genre/"]').each((_, el) => genres.push($(el).text().trim()));

        // --- EKSTRAK SERVER LENGKAP & BUNGKUS PROXY ---
        const extractedServers = [];

        // 1. Ekstrak dari Iframe Utama LK21 (yang sering jadi andalan)
        $('#playeriframe, iframe').each((_, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src');
            // Abaikan trailer youtube
            if (src && !src.includes('youtube.com')) {
                if (src.startsWith('//')) src = `https:${src}`;
                const proxyUrl = `https://playeriframe.lol/iframe.php?url=${encodeURIComponent(src)}`;
                if (!extractedServers.some(s => s.url === proxyUrl)) {
                    extractedServers.push({ name: "Server Utama (Bypass)", url: proxyUrl });
                }
            }
        });

        // 2. Ekstrak dari Tombol Provider Alternatif LK21 (Script temuanmu)
        $("#loadProviders > li > a, ul.providers li a, .server-option").each((i, el) => {
            const serverName = $(el).text().trim() || `Server ${i + 1}`;
            const href = $(el).attr("href") || $(el).attr("data-url");

            if (href) {
                let actualPlayerUrl = href;
                if (href.includes('url=')) {
                    actualPlayerUrl = decodeURIComponent(href.split('url=')[1]);
                } else if (href.startsWith('//')) {
                    actualPlayerUrl = `https:${href}`;
                }

                if (actualPlayerUrl.startsWith('http')) {
                    const proxyUrl = `https://playeriframe.lol/iframe.php?url=${encodeURIComponent(actualPlayerUrl)}`;
                    if (!extractedServers.some(s => s.url === proxyUrl)) {
                        extractedServers.push({ name: serverName, url: proxyUrl });
                    }
                }
            }
        });

        // 3. Fallback Ekstra (API Vidsrc/2Embed) Jika LK21 Sedang Error
        const imdbId = $('a[href*="imdb.com/title"]').attr('href')?.match(/tt\d+/)?.[0] || null;
        if (imdbId) {
            extractedServers.push(
                { name: "Server VIP (Vidsrc)", url: `https://vidsrc.to/embed/movie/${imdbId}` },
                { name: "Server Fast (2Embed)", url: `https://www.2embed.cc/embed/${imdbId}` }
            );
        }

        const responseData = {
            slug,
            title,
            status,
            quality,
            diterbitkan,
            bintang_film: bintang_film.length > 0 ? bintang_film.join(", ") : "N/A",
            genres: [...new Set(genres)],
            sinopsis,
            default_embed: extractedServers.length > 0 ? extractedServers[0].url : null,
            servers: extractedServers
        };

        if (extractedServers.length > 0) {
            await c.env.LK21_KV.put(cacheKey, JSON.stringify(responseData), { expirationTtl: CACHE_TTL });
        }
        
        return c.json({ status: true, source: "Live Scrape", ...responseData });

    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
});

export default app;
