const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const manifest = {
    id: "org.fahd.smartarabicsub",
    version: "1.2.0",
    name: "مترجم جوجل الذكي (EN -> AR)",
    description: "ترجمة ملفات SRT للعربية فوراً مع مطابقة بصمة الفيديو (Hash Match)",
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
                    .replace(/<[^>]*>/g, '')
                    .replace(/\{[^}]*\}/g, '')
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
        const openSubUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/${cleanId}${extraPath}.json`;

        const response = await axios.get(openSubUrl, { timeout: 6000 });
        const allSubs = response.data.subtitles || [];
        const engSubs = allSubs.filter(sub => sub.lang === 'eng' || sub.lang === 'en').slice(0, 5);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;

        const translatedSubtitles = engSubs.map((sub, index) => ({
            id: index === 0 ? `Google-AR-Match-1` : `Google-AR-Alt-${index + 1}`,
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
        const response = await axios.get(subUrl, { responseType: 'text', timeout: 7000 });
        const arabicSrt = await translateSrtToArabic(response.data);
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
