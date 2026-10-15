'use strict';
/*
 * PowerPoint (.pptx) import parser.
 *
 * Reads an Office Open XML presentation package and converts it into the same
 * shape the native importer already consumes: a title, an array of slides, a
 * list of referenced media files, and a list of warnings about anything that
 * could not be preserved.
 *
 * The parser is deliberately self-contained: it knows nothing about the
 * database, HTTP or storage layer. It only understands the .pptx format.
 */
const path = require('path');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  removeNSPrefix: false,
  allowBooleanAttributes: true,
  isArray: (name) => ['Override', 'Relationship', 'p:sldId', 'p:sld', 'p:sp', 'p:pic', 'p:cxnSp', 'p:graphicFrame', 'p:grpSp', 'a:p', 'a:r', 'a:br', 'a:buChar', 'a:buAutoNum'].includes(name)
};

const parser = new XMLParser(XML_OPTIONS);

const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_HLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';

const MAGIC = [
  { kind: 'image', mime: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: 'image', mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/gif', test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { kind: 'image', mime: 'image/webp', test: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { kind: 'video', mime: 'video/mp4', test: b => b.toString('ascii', 4, 8) === 'ftyp' },
  { kind: 'audio', mime: 'audio/mpeg', test: b => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { kind: 'audio', mime: 'audio/wav', test: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { kind: 'audio', mime: 'audio/ogg', test: b => b.toString('ascii', 0, 4) === 'OggS' }
];

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  return MAGIC.find(m => { try { return m.test(buf); } catch { return false; } }) || null;
}

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}

function normalisePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function resolveTarget(base, target) {
  if (!target) return '';
  if (target.startsWith('/') || /^[a-zA-Z]:/.test(target)) return normalisePath(target).replace(/^\//, '');
  // Relationship targets are relative to the source part, not the .rels file.
  // ppt/_rels/presentation.xml.rels -> ppt/presentation.xml
  const sourceBase = normalisePath(base).replace('/_rels/', '/').replace(/\.rels$/, '');
  const parts = sourceBase.split('/');
  parts.pop(); // directory of the source part
  for (const part of normalisePath(target).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function loadXml(entries, xmlPath) {
  const p = normalisePath(xmlPath).toLowerCase();
  const entry = entries.find(e => normalisePath(e.entryName).toLowerCase() === p);
  if (!entry) return null;
  const text = entry.getData().toString('utf8');
  try {
    return parser.parse(text);
  } catch (err) {
    throw new Error(`Could not parse ${xmlPath}: ${err.message}`);
  }
}

function parseRelationships(entries, relsPath) {
  const rels = {};
  const byType = {};
  const xml = loadXml(entries, relsPath);
  if (!xml || !xml.Relationships || !xml.Relationships.Relationship) return { rels, byType };
  for (const rel of (Array.isArray(xml.Relationships.Relationship) ? xml.Relationships.Relationship : [xml.Relationships.Relationship])) {
    const id = rel.Id;
    const type = rel.Type;
    const target = resolveTarget(relsPath, rel.Target);
    const item = { id, type, target, external: rel.TargetMode === 'External' };
    rels[id] = item;
    byType[type] = byType[type] || [];
    byType[type].push(item);
  }
  return { rels, byType };
}

function parseContentTypes(entries) {
  const xml = loadXml(entries, '[Content_Types].xml');
  if (!xml || !xml['Types'] || !xml['Types']['Override']) return null;
  const overrides = xml['Types']['Override'];
  const list = Array.isArray(overrides) ? overrides : [overrides];
  return list.map(t => String(t['ContentType'] || ''));
}

function parsePresentationXml(xml) {
  const pres = xml && xml['p:presentation'];
  const sldIdLst = pres && pres['p:sldIdLst'];
  const ids = [];
  if (sldIdLst && sldIdLst['p:sldId']) {
    const list = Array.isArray(sldIdLst['p:sldId']) ? sldIdLst['p:sldId'] : [sldIdLst['p:sldId']];
    for (const s of list) {
      ids.push({ id: s['id'], rId: s['r:id'] });
    }
  }
  const size = pres && pres['p:sldSz'];
  const dimensions = size ? {
    width: Number(size['cx']) || 9144000,
    height: Number(size['cy']) || 6858000,
    type: size['type'] || null
  } : { width: 9144000, height: 6858000, type: null };
  return { slideIds: ids, dimensions };
}

function hexColor(val) {
  if (!val || val.length !== 6) return null;
  return '#' + val.toUpperCase();
}

function parseColor(fill) {
  if (!fill) return null;
  if (fill['a:srgbClr'] && fill['a:srgbClr']['val']) return hexColor(fill['a:srgbClr']['val']);
  if (fill['a:schemeClr'] && fill['a:schemeClr']['val']) return null;
  return null;
}

function parseFill(bgPr, rels) {
  if (!bgPr) return { type: 'unknown' };
  if (bgPr['a:noFill'] !== undefined) return { type: 'none' };
  if (bgPr['a:solidFill']) return { type: 'solid', color: parseColor(bgPr['a:solidFill']) };
  if (bgPr['a:gradFill']) return { type: 'grad' };
  if (bgPr['a:blipFill']) {
    const blip = bgPr['a:blipFill']['a:blip'];
    const embed = blip && blip['r:embed'];
    const rel = embed && rels.rels[embed];
    return { type: 'image', image: rel ? rel.target : null };
  }
  return { type: 'unknown' };
}

function parseSlideBackground(sld, rels) {
  if (!sld || !sld['p:cSld'] || !sld['p:cSld']['p:bg']) return null;
  const bg = sld['p:cSld']['p:bg'];
  if (bg['p:bgPr']) return parseFill(bg['p:bgPr'], rels);
  if (bg['p:bgRef']) return { type: 'master' };
  return null;
}

function parseRunProperties(rPr) {
  if (!rPr) return {};
  const style = {};
  if (rPr['b'] === true || rPr['b'] === '1' || rPr['b'] === 1) style.bold = true;
  if (rPr['i'] === true || rPr['i'] === '1' || rPr['i'] === 1) style.italic = true;
  if (rPr['u'] === true || rPr['u'] === 'sng' || rPr['u'] === '1') style.underline = true;
  if (rPr['sz']) style.fontSize = Number(rPr['sz']) / 100;
  const color = parseColor(rPr['a:solidFill']);
  if (color) style.color = color;
  if (rPr['a:latin'] && rPr['a:latin']['typeface']) style.font = rPr['a:latin']['typeface'];
  else if (rPr['a:ea'] && rPr['a:ea']['typeface']) style.font = rPr['a:ea']['typeface'];
  return style;
}

function first(obj) {
  return Array.isArray(obj) ? obj[0] : obj;
}

function parseParagraphProperties(pPr) {
  if (!pPr) return { align: 'left', level: 0, bullet: '' };
  const alignMap = { ctr: 'center', r: 'right', l: 'left', just: 'left', dist: 'left', thaiDist: 'left' };
  const align = alignMap[pPr['algn']] || 'left';
  const level = Number(pPr['lvl']) || 0;
  let bullet = '';
  const buChar = first(pPr['a:buChar']);
  if (buChar && buChar['char']) bullet = buChar['char'] + ' ';
  else if (pPr['a:buAutoNum']) bullet = '• ';
  else if (pPr['a:buNone'] !== undefined) bullet = '';
  return { align, level, bullet };
}

function runText(t) {
  if (t === undefined || t === null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') return String(t['#text'] || t['text'] || '');
  return String(t);
}

function extractParagraphs(txBody, rels) {
  if (!txBody || !txBody['a:p']) return [];
  const source = Array.isArray(txBody['a:p']) ? txBody['a:p'] : [txBody['a:p']];
  const result = [];

  for (const p of source) {
    const pPr = parseParagraphProperties(p['a:pPr']);
    const runs = p['a:r'] ? (Array.isArray(p['a:r']) ? p['a:r'] : [p['a:r']]) : [];
    const parts = [];
    const runStyles = [];
    let hasHyperlink = false;

    for (const r of runs) {
      const text = runText(r['a:t']);
      if (!text && !r['a:t']) continue;
      const rPr = parseRunProperties(r['a:rPr']);
      const link = r['a:rPr'] && r['a:rPr']['a:hlinkClick'] && rels.rels[r['a:rPr']['a:hlinkClick']['r:id']];
      if (link && link.external) {
        parts.push(text + ' (' + link.target + ')');
        hasHyperlink = true;
      } else {
        parts.push(text);
      }
      runStyles.push(rPr);
    }

    let hasLineBreaks = false;
    if (p['a:br'] !== undefined) {
      hasLineBreaks = true;
      const brCount = Array.isArray(p['a:br']) ? p['a:br'].length : 1;
      parts.push('\n'.repeat(brCount));
    }

    const text = (pPr.bullet || '') + parts.join('');
    if (!text.trim()) continue;

    const { style } = dominantStyle(runStyles);
    result.push({
      text,
      style,
      rawStyles: runStyles,
      align: pPr.align,
      hasHyperlink,
      hasLineBreaks
    });
  }

  return result;
}

function extractTextFromBody(txBody, rels) {
  const paragraphs = extractParagraphs(txBody, rels);
  const runStyles = [];
  let align = 'left';
  let hasHyperlink = false;
  let hasLineBreaks = false;
  const lines = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (i === 0) align = p.align;
    lines.push(p.text);
    if (p.rawStyles) runStyles.push(...p.rawStyles);
    if (p.hasHyperlink) hasHyperlink = true;
    if (p.hasLineBreaks) hasLineBreaks = true;
  }

  return { text: lines.join('\n'), paragraphs, runStyles, hasHyperlink, align, hasLineBreaks };
}

function dominantStyle(runStyles) {
  if (!runStyles || !runStyles.length) return { style: {}, mixed: false };
  const first = runStyles[0];
  let mixed = false;
  for (const s of runStyles) {
    if (s.fontSize !== first.fontSize || s.bold !== first.bold || s.color !== first.color || s.font !== first.font) {
      mixed = true;
      break;
    }
  }
  const style = {};
  if (first.font) style.font = first.font;
  if (first.fontSize) style.size = Math.round(first.fontSize);
  if (first.bold === true) style.weight = 700;
  else style.weight = 400;
  if (first.italic) style.italic = true;
  if (first.color) style.color = first.color;
  return { style, mixed };
}

function parseShape(shape, rels) {
  if (!shape) return null;
  const nv = shape['p:nvSpPr'] || shape['p:nvPicPr'] || shape['p:nvGraphicFramePr'] || shape['p:nvCxnSpPr'];
  const shapeName = (nv && nv['p:cNvPr'] && nv['p:cNvPr']['name']) || '';
  const isPlaceholder = shape['p:nvSpPr'] && shape['p:nvSpPr']['p:nvPr'] && shape['p:nvSpPr']['p:nvPr']['p:ph'];

  if (shape['p:graphicFrame'] || shape['p:nvGraphicFramePr'] || shape['a:graphic']) return { type: 'graphic', name: shapeName, kind: 'chart-or-smartart' };
  if (shape['p:nvCxnSpPr']) return { type: 'shape', name: shapeName, kind: 'line' };

  const blipFill = shape['p:blipFill'] || (shape['p:spPr'] && shape['p:spPr']['a:blipFill']);
  if (blipFill) {
    const blip = blipFill['a:blip'];
    const embed = blip && blip['r:embed'];
    const rel = embed && rels.rels[embed];
    return { type: 'image', name: shapeName, path: rel ? rel.target : null };
  }

  if (shape['p:txBody']) {
    const extracted = extractTextFromBody(shape['p:txBody'], rels);
    const bodyPr = shape['p:txBody']['a:bodyPr'] || {};
    return { type: 'text', name: shapeName, isPlaceholder, ...extracted, anchor: bodyPr['anchor'] };
  }

  return { type: 'shape', name: shapeName, kind: 'unknown' };
}

function collectShapes(tree, rels, list = []) {
  if (!tree) return list;
  for (const key of Object.keys(tree)) {
    const val = tree[key];
    if (!val) continue;
    const items = Array.isArray(val) ? val : [val];
    for (const item of items) {
      if (key === 'p:sp' || key === 'p:pic' || key === 'p:graphicFrame' || key === 'p:cxnSp') {
        list.push(parseShape(item, rels));
      } else if (key === 'p:grpSp') {
        collectShapes(item, rels, list);
      }
    }
  }
  return list;
}

function parseSlide(sldXml, slideRels, notesText, slideIndex) {
  let sld = sldXml && sldXml['p:sld'];
  if (Array.isArray(sld)) sld = sld[0];
  const warnings = [];

  const bg = parseSlideBackground(sld, slideRels);
  let background = null;
  let backgroundMedia = null;
  if (bg) {
    if (bg.type === 'solid' && bg.color) background = bg.color;
    else if (bg.type === 'grad') warnings.push(`Slide ${slideIndex + 1}: gradient backgrounds are not supported.`);
    else if (bg.type === 'image' && bg.image) backgroundMedia = bg.image;
    else if (bg.type === 'master') warnings.push(`Slide ${slideIndex + 1}: background inherited from master slide was not preserved.`);
  }

  const spTree = sld && sld['p:cSld'] && sld['p:cSld']['p:spTree'];
  const shapes = collectShapes(spTree, slideRels).filter(Boolean);

  const textShapes = [];
  const imageShapes = [];
  for (const shape of shapes) {
    if (shape.type === 'text') textShapes.push(shape);
    else if (shape.type === 'image') imageShapes.push(shape);
    else if (shape.type === 'graphic') warnings.push(`Slide ${slideIndex + 1}: ${shape.kind} (${shape.name || 'unnamed'}) was skipped.`);
    else if (shape.type === 'shape') warnings.push(`Slide ${slideIndex + 1}: shape (${shape.name || 'unnamed'}) was skipped.`);
  }

  // Collect every paragraph from every text shape so we can split by font size.
  const allParagraphs = [];
  let hasHyperlinks = false;
  let hasLineBreaks = false;
  for (const shape of textShapes) {
    if (shape.paragraphs) allParagraphs.push(...shape.paragraphs);
    if (shape.hasHyperlink) hasHyperlinks = true;
    if (shape.hasLineBreaks) hasLineBreaks = true;
  }

  if (hasHyperlinks) warnings.push(`Slide ${slideIndex + 1}: hyperlinks were converted to visible text.`);
  if (hasLineBreaks) warnings.push(`Slide ${slideIndex + 1}: manual line breaks were approximated.`);

  if (imageShapes.length && !backgroundMedia) {
    backgroundMedia = imageShapes[0].path;
    if (imageShapes.length > 1) warnings.push(`Slide ${slideIndex + 1}: ${imageShapes.length - 1} additional image(s) were skipped.`);
  }

  const mainParagraphs = [];
  const footerParagraphs = [];
  let mainSize = 0;

  if (allParagraphs.length) {
    const sizes = allParagraphs.map(p => p.style.size || 0).filter(Boolean);
    mainSize = sizes.length ? Math.max(...sizes) : 0;
    const threshold = mainSize * 0.65;

    for (const p of allParagraphs) {
      const size = p.style.size || 0;
      if (size && size < threshold) footerParagraphs.push(p);
      else mainParagraphs.push(p);
    }
  }

  const slideName = (notesText || '').slice(0, 200)
    || (mainParagraphs[0] && mainParagraphs[0].text || '').split('\n')[0].slice(0, 60)
    || `Slide ${slideIndex + 1}`;

  function styleFromParagraphs(paragraphs, defaultAlign) {
    const styles = paragraphs.map(p => p.style).filter(Boolean);
    const { style } = dominantStyle(styles.map(s => ({
      fontSize: s.size,
      bold: s.weight === 700,
      italic: s.italic,
      color: s.color,
      font: s.font
    })));
    const out = {};
    if (style.font) out.font = style.font;
    if (style.size) out.size = style.size;
    if (styles.length) out.weight = style.weight;
    if (style.italic) out.italic = true;
    if (style.color) out.color = style.color;

    const align = paragraphs[0] && paragraphs[0].align;
    if (align && align !== 'center') out.align = align;
    else if (defaultAlign && defaultAlign !== 'center') out.align = defaultAlign;
    return out;
  }

  const slideStyle = styleFromParagraphs(mainParagraphs, 'center');
  const footerStyle = footerParagraphs.length ? styleFromParagraphs(footerParagraphs, 'center') : null;

  const slide = {
    text: mainParagraphs.map(p => p.text).join('\n\n').slice(0, 4000),
    name: slideName,
    style: slideStyle,
    background: backgroundMedia ? mediaPlaceholder(backgroundMedia) : background,
    image: null,
    warnings
  };

  if (footerStyle) {
    slide.footer = {
      text: footerParagraphs.map(p => p.text).join('\n\n').slice(0, 2000),
      style: footerStyle
    };
    if (!slide.footer.style.size && mainSize) slide.footer.style.size = Math.max(12, Math.round(mainSize * 0.35));
    if (!slide.footer.style.color && slideStyle.color) slide.footer.style.color = slideStyle.color;
  }

  return slide;
}

function mediaPlaceholder(mediaPath) {
  return 'pptx-media://' + normalisePath(mediaPath);
}

function extractNotes(entries, notesRels) {
  const notes = {};
  if (!notesRels || !notesRels.length) return notes;
  for (const rel of notesRels) {
    const xml = loadXml(entries, rel.target);
    if (!xml || !xml['p:notes']) continue;
    const relsPath = rel.target.replace(/\.xml$/, '.xml.rels').replace(/([^/]+)$/, '_rels/$1');
    const rels = parseRelationships(entries, relsPath);
    const slideRel = Object.values(rels.rels).find(r => r.type === REL_SLIDE);
    if (!slideRel) continue;
    const notesTextParts = [];
    const spTree = xml['p:notes']['p:cSld'] && xml['p:notes']['p:cSld']['p:spTree'];
    if (spTree) {
      for (const key of Object.keys(spTree)) {
        const val = spTree[key];
        const list = Array.isArray(val) ? val : [val];
        for (const item of list) {
          if (key === 'p:sp' && item['p:txBody']) {
            const { text } = extractTextFromBody(item['p:txBody'], rels);
            if (text.trim()) notesTextParts.push(text.trim());
          }
        }
      }
    }
    notes[slideRel.target] = notesTextParts.join('\n').slice(0, 1000);
  }
  return notes;
}

function parsePptx(buffer) {
  if (!buffer || buffer.length < 4) throw new Error('The file is empty.');
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('The file is not a PowerPoint presentation (.pptx).');

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error('The file is not a readable archive: ' + err.message);
  }

  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const contentTypes = parseContentTypes(entries);
  if (!contentTypes || !contentTypes.some(t => t.includes('presentationml'))) {
    throw new Error('The archive is not a PowerPoint presentation.');
  }

  const presentationXml = loadXml(entries, 'ppt/presentation.xml');
  if (!presentationXml || !presentationXml['p:presentation']) throw new Error('The presentation is missing its main document.');

  const presRels = parseRelationships(entries, 'ppt/_rels/presentation.xml.rels');
  const { slideIds, dimensions } = parsePresentationXml(presentationXml);
  if (!slideIds.length) throw new Error('The presentation contains no slides.');

  const notesRels = presRels.byType[REL_NOTES] || [];
  const notesBySlidePath = extractNotes(entries, notesRels);

  const slides = [];
  const warnings = [];
  const referencedMedia = new Set();

  for (let i = 0; i < slideIds.length; i++) {
    const { rId } = slideIds[i];
    const rel = presRels.rels[rId];
    if (!rel || rel.type !== REL_SLIDE) {
      warnings.push(`Slide ${i + 1}: could not locate slide file.`);
      continue;
    }
    const slidePath = rel.target;
    const sldXml = loadXml(entries, slidePath);
    if (!sldXml || !sldXml['p:sld']) {
      warnings.push(`Slide ${i + 1}: could not read slide content.`);
      continue;
    }
    const relsPath = slidePath.replace(/\.xml$/, '.xml.rels').replace(/([^/]+)$/, '_rels/$1');
    const slideRels = parseRelationships(entries, relsPath);
    const notesText = notesBySlidePath[slidePath] || '';
    const slide = parseSlide(sldXml, slideRels, notesText, i);
    slides.push(slide);
    warnings.push(...slide.warnings);

    if (slide.background && slide.background.startsWith('pptx-media://')) {
      referencedMedia.add(slide.background.slice('pptx-media://'.length));
    }
  }

  const mediaFiles = [];
  for (const mediaPath of referencedMedia) {
    const entry = entries.find(e => normalisePath(e.entryName).toLowerCase() === mediaPath.toLowerCase());
    if (!entry) {
      warnings.push(`Media ${path.basename(mediaPath)} was referenced but not found in the package.`);
      continue;
    }
    const buf = entry.getData();
    const detected = sniff(buf);
    if (!detected) {
      warnings.push(`Media ${path.basename(mediaPath)} was skipped because its file type is not supported.`);
      continue;
    }
    mediaFiles.push({
      path: mediaPath,
      originalName: safeName(path.basename(mediaPath)),
      buffer: buf,
      size: buf.length,
      ...detected
    });
  }

  const core = loadXml(entries, 'docProps/core.xml');
  let title = '';
  if (core && core['cp:coreProperties']) {
    title = String(core['cp:coreProperties']['dc:title'] || core['cp:coreProperties']['dc:subject'] || '').trim();
  }

  return {
    title: title || 'Imported presentation',
    slides,
    media: mediaFiles,
    warnings,
    dimensions
  };
}

module.exports = { parsePptx };
