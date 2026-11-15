const express = require("express");
const cors = require("cors");
const axios = require("axios");
const zlib = require("zlib");

const app = express();
app.use(cors());

const manifest = {
    id: "org.fahd.smartarabicsub",
    version: "1.4.0",
    name: "مترجم جوجل الذكي (مطابقة تلقائية للنسخة)",
    description: "يتعرف على نوع الحلقة (WEB/BluRay/HDTV) ويرتب الترجمة الموزونة تلقائياً",
    resources: [
        {
            name: "subtitles",
            types: ["movie", "series"],
            idPrefixes: ["tt"]
        }
    ],
    types: ["movie", "series"],
    catalogs: []
};

// تحليل المعاملات المرسلة من Nuvio (البصمة الرقمية واسم ملف الحلقة)
function parseExtraParams(extraStr) {
    const params = {};
    if (!extraStr) return params;
    const clean = extraStr.replace(/\.json$/, '');
    clean.split('&').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx !== -1) {
            const key = pair.slice(0, idx);
            const val = decodeURIComponent(pair.slice(idx + 1));
            params[key] = val;
        }
    });
    return params;
}

// خوارزمية التعرف على نوع الحلقة ومطابقة اسم الملف والبصمة
function calculateMatchScore(sub, videoFilename, hasVideoHash, sourceName, indexInSource) {
    let score = 0;
    let badge = "";

    // OpenSubtitles يضع المطابق للبصمة الرقمية في المرتبة الأولى
    if (sourceName === "OpenSub" && hasVideoHash && indexInSource === 0) {
        score += 100;
        badge = "Hash-Match";
    }

    const subText = `${sub.id || ''} ${sub.url || ''} ${sub.title || ''} ${sub.release || ''}`.toLowerCase();
    const vidText = (videoFilename || '').toLowerCase();

    if (vidText) {
        // 1. مطابقة مصدر الفيديو (WEB / BluRay / HDTV / DVD)
        const sources = [
            { tag: "WEB", keys: ["web-dl", "webrip", "web.", ".web"] },
            { tag: "BluRay", keys: ["bluray", "bdrip", "brrip", "remux"] },
            { tag: "HDTV", keys: ["hdtv", "pdtv", "dsr"] },
            { tag: "DVD", keys: ["dvdrip", "dvd"] }
        ];

        for (const src of sources) {
            const vidHas = src.keys.some(k => vidText.includes(k));
            const subHas = src.keys.some(k => subText.includes(k));
            if (vidHas && subHas) {
                score += 35;
                if (!badge) badge = src.tag;
            }
        }

        // 2. مطابقة الدقة (1080p / 720p / 2160p)
        const resolutions = ["2160p", "1080p", "720p", "480p"];
        for (const res of resolutions) {
            if (vidText.includes(res) && subText.includes(res)) {
                score += 15;
            }
        }

        // 3. مطابقة اسم فريق الرفع (Release Group) مثل FLUX, NTb, RARBG, PSA, YIFY
        const cleanVidName = vidText.replace(/\.[a-z0-9]{2,4}$/, ''); // إزالة الامتداد مثل .mkv
        const groupMatch = cleanVidName.match(/[-.]([a-z0-9]{2,12})$/i);
        if (groupMatch && groupMatch[1]) {
            const releaseGroup = groupMatch[1].toLowerCase();
            const ignoredWords = ["mkv", "mp4", "avi", "x264", "x265", "hevc", "aac", "ac3", "1080p", "720p"];
            if (!ignoredWords.includes(releaseGroup) && subText.includes(releaseGroup)) {
                score += 55;
                badge = `${releaseGroup.toUpperCase()}-Match`;
            }
        }
    }

    return { score, badge };
}

async function fetchRawSrt(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 7000,
        headers: { "User-Agent": "Mozilla/5.0" }
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer).toString('utf-8');
    }
    return buffer.toString('utf-8');
}

async function translateSrtToArabic(srtContent) {
    const cleanSrt = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = cleanSrt.split(/\n\n+/);
    const parsedBlocks = [];

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length >= 2) {
            const timeIndex = lines.findIndex(l => l.includes('-->'));
            if (timeIndex !== -1) {
                const textLines = lines.slice(timeIndex + 1).join(' ')
                    .replace(/<\/?[^>]+(>|$)/g, '')
                    .trim();
                if (textLines) {
                    parsedBlocks.push({
                        id: parsedBlocks.length + 1,
                        time: lines[timeIndex].trim(),
                        text: textLines
                    });
                }
            }
        }
    }

    const chunkSize = 35;
    const chunks = [];
    for (let i = 0; i < parsedBlocks.length; i += chunkSize) {
        chunks.push(parsedBlocks.slice(i, i + chunkSize));
    }

    await Promise.all(chunks.map(async (chunk) => {
        const combinedText = chunk.map(b => b.text).join('\n');
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(combinedText)}`;
            const res = await axios.get(url, {
                timeout: 8000,
                headers: { "User-Agent": "Mozilla/5.0" }
            });
            const translatedFull = res.data[0].map(item => item[0]).join('');
            const translatedLines = translatedFull.split('\n');

            chunk.forEach((b, idx) => {
                b.translated = (translatedLines[idx] && translatedLines[idx].trim()) ? translatedLines[idx].trim() : b.text;
            });
        } catch (err) {
            chunk.forEach(b => { b.translated = b.text; });
        }
    }));

    return parsedBlocks.map(b => `${b.id}\n${b.time}\n${b.translated}`).join('\n\n') + '\n';
}

app.get('/', (req, res) => {
    res.redirect('/manifest.json');
});

app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get(['/subtitles/:type/:id/:extra.json', '/subtitles/:type/:id.json'], async (req, res) => {
    try {
        const { type, id, extra } = req.params;
        const cleanId = id.replace(/\.json$/, '');
        const cleanExtra = extra ? extra.replace(/\.json$/, '') : '';
        const extraPath = cleanExtra ? `/${cleanExtra}` : '';

        // قراءة اسم ملف الفيديو وبصمته من Nuvio
        const extraParams = parseExtraParams(cleanExtra);
        const videoFilename = extraParams.filename || '';
        const hasVideoHash = Boolean(extraParams.videoHash);

        const sources = [
            { name: "OpenSub", url: `https://opensubtitles-v3.strem.io/subtitles/${type}/${cleanId}${extraPath}.json` },
            { name: "SubDL", url: `https://subdl.strem.top/subtitles/${type}/${cleanId}${extraPath}.json` },
            { name: "OS-Pro", url: `https://opensubtitles.stremio.ru/subtitles/${type}/${cleanId}${extraPath}.json` }
        ];

        const results = await Promise.allSettled(
            sources.map(src => axios.get(src.url, { timeout: 4500 }).then(r => ({
                sourceName: src.name,
                subs: r.data.subtitles || []
            })))
        );

        let scoredSubs = [];
        const seenUrls = new Set();

        for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value.subs)) {
                const engList = result.value.subs.filter(sub => {
                    const lang = (sub.lang || '').toLowerCase();
                    return (lang === 'eng' || lang === 'en' || lang.includes('english') || lang.includes('sdh'));
                });

                engList.forEach((sub, idx) => {
                    if (sub.url && !seenUrls.has(sub.url)) {
                        seenUrls.add(sub.url);
                        const { score, badge } = calculateMatchScore(
                            sub,
                            videoFilename,
                            hasVideoHash,
                            result.value.sourceName,
                            idx
                        );
                        scoredSubs.push({
                            url: sub.url,
                            source: result.value.sourceName,
                            score,
                            badge
                        });
                    }
                });
            }
        }

        // ترتيب الترجمات تلقائياً بحيث تكون الأكثر تطابقاً مع الحلقة في الأعلى دائماً
        scoredSubs.sort((a, b) => b.score - a.score);

        const topSubs = scoredSubs.slice(0, 8);
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;

        const translatedSubtitles = topSubs.map((sub, index) => {
            const matchLabel = sub.badge ? ` [${sub.badge}]` : '';
            return {
                id: index === 0
                    ? `AR-Best-1 (${sub.source})${matchLabel}`
                    : `AR-${index + 1} (${sub.source})${matchLabel}`,
                url: `${host}/translate.srt?url=${encodeURIComponent(sub.url)}`,
                lang: "ara"
            };
        });

        res.json({ subtitles: translatedSubtitles });
    } catch (e) {
        res.json({ subtitles: [] });
    }
});

app.get(['/translate.srt', '/translate'], async (req, res) => {
    const subUrl = req.query.url;
    if (!subUrl) return res.status(400).send("Missing URL");

    try {
        const rawSrt = await fetchRawSrt(subUrl);
        const arabicSrt = await translateSrtToArabic(rawSrt);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(arabicSrt);
    } catch (error) {
        res.status(500).send("Error translating subtitle");
    }
});

const port = process.env.PORT || 7000;
if (require.main === module) {
    app.listen(port, () => console.log(`Addon active on port ${port}`));
}

module.exports = app;
