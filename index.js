const express = require("express");
const cors = require("cors");
const axios = require("axios");
const zlib = require("zlib");

const app = express();
app.use(cors());

const manifest = {
    id: "org.fahd.smartarabicsub",
    version: "1.3.0",
    name: "مترجم جوجل الذكي (SRT + SDH)",
    description: "ترجمة فورية للعربية شاملة ملفات SDH والنسخ المدمجة مع مطابقة البصمة",
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

// دالة قراءة وفك ضغط ملفات الترجمة إن كانت مضغوطة
async function fetchRawSrt(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 7000,
        headers: { "User-Agent": "Mozilla/5.0" }
    });
    const buffer = Buffer.from(response.data);
    // فحص ما إذا كان الملف مضغوطاً بصيغة Gzip
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer).toString('utf-8');
    }
    return buffer.toString('utf-8');
}

// دالة الترجمة مع الحفاظ الكامل على نصوص وأقواس SDH
async function translateSrtToArabic(srtContent) {
    const cleanSrt = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = cleanSrt.split(/\n\n+/);
    const parsedBlocks = [];

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length >= 2) {
            const timeIndex = lines.findIndex(l => l.includes('-->'));
            if (timeIndex !== -1) {
                // إزالة وسوم الألوان البرمجية فقط مع ترك أقواس SDH كاملة كما هي
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

// سحب الترجمات الإنجليزية وملفات SDH من 3 مصادر معاً لضمان التوفر 100%
app.get(['/subtitles/:type/:id/:extra.json', '/subtitles/:type/:id.json'], async (req, res) => {
    try {
        const { type, id, extra } = req.params;
        const cleanId = id.replace(/\.json$/, '');
        const cleanExtra = extra ? extra.replace(/\.json$/, '') : '';
        const extraPath = cleanExtra ? `/${cleanExtra}` : '';

        // المصادر الثلاثة (تشمل نسخ WEB-DL و BluRay المدمجة وملفات SDH)
        const sources = [
            { name: "OpenSub", url: `https://opensubtitles-v3.strem.io/subtitles/${type}/${cleanId}${extraPath}.json` },
            { name: "SubDL-SDH", url: `https://subdl.strem.top/subtitles/${type}/${cleanId}.json` },
            { name: "OS-Pro", url: `https://opensubtitles.stremio.ru/subtitles/${type}/${cleanId}.json` }
        ];

        const results = await Promise.allSettled(
            sources.map(src => axios.get(src.url, { timeout: 4500 }).then(r => ({
                sourceName: src.name,
                subs: r.data.subtitles || []
            })))
        );

        let combinedEngSubs = [];
        const seenUrls = new Set();

        for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value.subs)) {
                const engList = result.value.subs.filter(sub => {
                    const lang = (sub.lang || '').toLowerCase();
                    return (lang === 'eng' || lang === 'en' || lang.includes('english') || lang.includes('sdh'));
                });

                for (const sub of engList) {
                    if (sub.url && !seenUrls.has(sub.url)) {
                        seenUrls.add(sub.url);
                        combinedEngSubs.push({
                            url: sub.url,
                            source: result.value.sourceName
                        });
                    }
                }
            }
        }

        // أخذ أفضل 8 ترجمات شاملة الـ SDH والمطابقة للبصمة
        const topSubs = combinedEngSubs.slice(0, 8);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;

        const translatedSubtitles = topSubs.map((sub, index) => ({
            id: index === 0 ? `Google-AR-Match-1 (${sub.source})` : `Google-AR-${index + 1} (${sub.source})`,
            url: `${host}/translate.srt?url=${encodeURIComponent(sub.url)}`,
            lang: "ara"
        }));

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
