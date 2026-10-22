// docgen.js - dependency-free PDF / DOCX / TXT writers (for tailored CVs) and DOCX text extraction.
// Input text is light markdown:  "# Name", "## Section", "- bullet", blank line = gap.
(() => {
  const enc = new TextEncoder();

  // ---------- helpers ----------
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const bytesToB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  // ---------- minimal ZIP writer (stored, no compression) ----------
  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return concat([...chunks, ...central, new Uint8Array(end.buffer)]);
  }

  // ---------- text -> structured lines ----------
  function parse(text) {
    return String(text).replace(/\r/g, '').split('\n').map((raw) => {
      let l = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').trimEnd();
      if (!l.trim()) return { t: 'gap', s: '' };
      if (/^#\s+/.test(l)) return { t: 'h1', s: l.replace(/^#\s+/, '') };
      if (/^#{2,}\s+/.test(l)) return { t: 'h2', s: l.replace(/^#{2,}\s+/, '') };
      if (/^\s*[-*•]\s+/.test(l)) return { t: 'li', s: l.replace(/^\s*[-*•]\s+/, '') };
      return { t: 'p', s: l.trim() };
    });
  }

  // ---------- PDF (Helvetica, WinAnsi) ----------
  const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const MAP = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '\u0095', '€': '\u0080', '\u00a0': ' ', '→': '->', '✓': '*' };
  const ansi = (s) => [...s].map((ch) => {
    if (MAP[ch]) return MAP[ch];
    const c = ch.codePointAt(0);
    if (c === 9) return ' ';
    return c < 32 ? '' : c <= 255 ? ch : '?';
  }).join('');
  const pesc = (s) => s.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));
  const tw = (s, size, bold) => [...s].reduce((a, ch) => a + (W[ch.charCodeAt(0) - 32] ?? 556), 0) * size / 1000 * (bold ? 1.05 : 1);

  function pdf(text) {
    const PW = 595, PH = 842, M = 54;
    const pages = [[]];
    let y = PH - M;
    const newPage = () => { pages.push([]); y = PH - M; };
    const line = (s, x, size, bold, lh) => {
      y -= lh;
      if (y < M) { newPage(); y -= lh; }
      pages[pages.length - 1].push(`BT ${bold ? '/F2' : '/F1'} ${size} Tf ${x} ${y.toFixed(1)} Td (${pesc(s)}) Tj ET`);
    };
    const wrap = (s, size, bold, maxW) => {
      const out = []; let cur = '';
      for (const w of s.split(' ')) {
        const t = cur ? cur + ' ' + w : w;
        if (cur && tw(t, size, bold) > maxW) { out.push(cur); cur = w; } else cur = t;
      }
      if (cur) out.push(cur);
      return out;
    };
    for (const l of parse(text)) {
      const s = ansi(l.s);
      if (l.t === 'gap') { y -= 5; continue; }
      if (l.t === 'h1') { for (const w of wrap(s, 19, true, PW - 2 * M)) line(w, M, 19, true, 24); }
      else if (l.t === 'h2') { y -= 7; for (const w of wrap(s.toUpperCase(), 11.5, true, PW - 2 * M)) line(w, M, 11.5, true, 15); }
      else if (l.t === 'li') {
        const ws = wrap(s, 10.5, false, PW - 2 * M - 16);
        ws.forEach((w, i) => {
          line(w, M + 16, 10.5, false, 14);
          if (i === 0) pages[pages.length - 1].push(`BT /F1 10.5 Tf ${M + 4} ${y.toFixed(1)} Td (\\225) Tj ET`);
        });
      } else for (const w of wrap(s, 10.5, false, PW - 2 * M)) line(w, M, 10.5, false, 14);
    }
    const objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    pages.forEach((ops, i) => {
      const s = ops.join('\n');
      objs[5 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
      objs[6 + 2 * i] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
    });
    let out = '%PDF-1.4\n'; const off = [];
    for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
    const x = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
    return enc.encode(out);
  }

  // ---------- DOCX ----------
  const xesc = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function docx(text) {
    const run = (s, sz, bold) =>
      `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${xesc(s)}</w:t></w:r>`;
    const para = (ppr, r) => `<w:p><w:pPr>${ppr}</w:pPr>${r}</w:p>`;
    const body = parse(text).map((l) => {
      switch (l.t) {
        case 'gap': return para('<w:spacing w:after="0"/>', '');
        case 'h1': return para('<w:spacing w:after="60"/>', run(l.s, 36, true));
        case 'h2': return para('<w:spacing w:before="200" w:after="40"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="999999"/></w:pBdr>', run(l.s.toUpperCase(), 23, true));
        case 'li': return para('<w:spacing w:after="20"/><w:ind w:left="360" w:hanging="220"/>', run('• ' + l.s, 21, false));
        default: return para('<w:spacing w:after="40"/>', run(l.s, 21, false));
      }
    }).join('');
    const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(`${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
      { name: '_rels/.rels', data: enc.encode(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
      { name: 'word/document.xml', data: enc.encode(`${X}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1100" w:bottom="1000" w:left="1100" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`) },
    ];
    return zip(files);
  }

  const txt = (text) => enc.encode(String(text).replace(/\*\*/g, ''));

  // ---------- DOCX -> text (for importing a CV you already have) ----------
  async function inflateRaw(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function docxToText(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a zip/docx file');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    for (let i = 0; i < count; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      if (name === 'word/document.xml') {
        const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
        const raw = u8.subarray(start, start + csize);
        const xml = new TextDecoder().decode(method === 8 ? await inflateRaw(raw) : raw);
        return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
          .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
      }
      p += 46 + nl + el + cl;
    }
    throw new Error('word/document.xml not found');
  }

  globalThis.DocGen = { pdf, docx, txt, docxToText, bytesToB64, b64ToBytes };
})();
